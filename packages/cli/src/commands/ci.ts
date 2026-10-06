import { execFile } from "node:child_process";
import { appendFile, readFile, readdir } from "node:fs/promises";
import {
  ConfigError,
  QajitsuError,
  TicketKeySchema,
  exitCodeFor,
  type ChangeTarget,
  type CodeHost,
  type TestStatus,
} from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import { z } from "zod";
import { buildAdapters, type RuntimePorts } from "../adapters.js";
import { loadProject } from "../project.js";
import { openSession, type ModelPorts, type RunSession } from "../session.js";
import type { CommandIO } from "./fetch.js";
import { publisherFor } from "./publish.js";
import { computeVerdict } from "./verdict.js";

// GitHub event payloads are untrusted input: parsed with Zod, unknown fields ignored.
const PullRequestEvent = z.object({
  pull_request: z.object({
    number: z.number().int(),
    title: z.string(),
    html_url: z.string().optional(),
    labels: z.array(z.object({ name: z.string() })).default([]),
    head: z.object({ ref: z.string(), sha: z.string() }),
  }),
});
const IssueCommentEvent = z.object({
  issue: z.object({
    title: z.string(),
    html_url: z.string().optional(),
    pull_request: z.object({ html_url: z.string().optional() }).optional(),
  }),
  comment: z.object({
    body: z.string(),
    user: z.object({ login: z.string(), type: z.string().optional() }),
    author_association: z.string(),
  }),
});
const DispatchEvent = z.object({
  inputs: z.record(z.string(), z.string()).optional(),
  client_payload: z.record(z.string(), z.string()).optional(),
});

/** Comment authors on GitHub who may approve or revise a plan from a PR comment (REQ-PLAN-07/AC2). */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** What started a pipeline and what it should do (REQ-CI-02). */
export interface CiTrigger {
  readonly trigger: "label" | "comment" | "manual" | "jira" | "none";
  readonly run: boolean;
  readonly reason: string;
  readonly ticket?: string | undefined;
  readonly env?: string | undefined;
  /** `plan`: plan and wait for approval; `run`: execute an approved plan; `full`: both, approval in between. */
  readonly mode?: "plan" | "run" | "full" | undefined;
  readonly change?: { readonly url: string; readonly sha?: string | undefined } | undefined;
  /** A `/qa approve` or `/qa revise <text>` comment (REQ-CI-03/AC2, AC3). */
  readonly command?:
    | {
        readonly name: "approve" | "revise";
        readonly text: string;
        /** Plan version named in `/qa approve v<N>`; approval is pinned to it. */
        readonly version?: number | undefined;
        readonly user: string;
        readonly allowed: boolean;
      }
    | undefined;
}

/**
 * Parses `/qa approve v<N>` or `/qa revise <instruction>` from a comment. Approval names the plan version
 * the reviewer read, so a newer version written in between is never approved by an older comment.
 */
export function parseQaCommand(
  body: string,
): { name: "approve" | "revise"; text: string; version?: number } | undefined {
  const m = /^\s*\/qa\s+(approve|revise)\b[ \t]*(.*)$/m.exec(body);
  if (!m) return undefined;
  const text = (m[2] ?? "").trim();
  if (m[1] === "revise") return { name: "revise", text };
  const v = /^v(\d{1,4})\b/.exec(text);
  return v ? { name: "approve", text, version: Number(v[1]) } : { name: "approve", text };
}

/** Profile names and similar single tokens only: nothing that could break a shell line or an output file. */
const SAFE = /^[A-Za-z0-9][\w.:/@-]{0,199}$/;
const safeOrUndefined = (v: string | undefined): string | undefined =>
  v !== undefined && SAFE.test(v) ? v : undefined;

const nonEmpty = (v: string | undefined): string | undefined => (v === undefined || v === "" ? undefined : v);

const ticketIn = (texts: readonly (string | undefined)[], projectKey: string): string | undefined => {
  const re = new RegExp(`\\b${projectKey}-[1-9]\\d{0,8}\\b`);
  for (const t of texts) {
    const m = t ? re.exec(t) : null;
    if (m) return m[0];
  }
  return undefined;
};

/**
 * Works out the trigger from the CI environment (REQ-CI-02): a PR/MR carrying the label (default
 * `qa-agent`) with the ticket key in the branch or title, a `/qa` comment, a manual run with ticket,
 * environment and mode, or a dispatch from a Jira automation.
 *
 * @param env - Process environment of the CI job.
 * @param event - Parsed GitHub event payload (`GITHUB_EVENT_PATH`), when there is one.
 * @param options - Jira project key and the label.
 */
export function detectTrigger(
  env: Readonly<Record<string, string | undefined>>,
  event: Record<string, unknown> | undefined,
  options: { readonly projectKey: string; readonly label: string },
): CiTrigger {
  const none = (reason: string): CiTrigger => ({ trigger: "none", run: false, reason });
  const key = (t: string | undefined) => (t && TicketKeySchema.safeParse(t).success ? t : undefined);
  const mode = (m: string | undefined) => (m === "plan" || m === "run" || m === "full" ? m : undefined);
  if (env["GITHUB_ACTIONS"] === "true") {
    const name = env["GITHUB_EVENT_NAME"];
    const server = env["GITHUB_SERVER_URL"] ?? "https://github.com";
    // pull_request_target is not accepted: it runs with secrets for fork PRs.
    if (name === "pull_request") {
      const parsed = PullRequestEvent.safeParse(event);
      if (!parsed.success) return none("unexpected pull_request payload");
      const pr = parsed.data.pull_request;
      if (!pr.labels.some((l) => l.name === options.label))
        return none(`pull request has no '${options.label}' label`);
      const ticket = ticketIn([pr.head.ref, pr.title], options.projectKey);
      if (!ticket) return none(`no ${options.projectKey} ticket key in the branch or title`);
      return {
        trigger: "label",
        run: true,
        reason: `label ${options.label}`,
        ticket,
        mode: "full",
        change: {
          url: pr.html_url ?? `${server}/${env["GITHUB_REPOSITORY"] ?? ""}/pull/${String(pr.number)}`,
          sha: pr.head.sha,
        },
      };
    }
    if (name === "issue_comment") {
      const parsed = IssueCommentEvent.safeParse(event);
      if (!parsed.success) return none("unexpected issue_comment payload");
      const { issue, comment } = parsed.data;
      if (!issue.pull_request) return none("comment is not on a pull request");
      // QAJitsu's own comments (they quote plans) and bots never trigger anything.
      if (
        comment.body.includes("<!-- qajitsu:") ||
        comment.user.type === "Bot" ||
        comment.user.login.endsWith("[bot]")
      )
        return none("comment by QAJitsu or a bot");
      const cmd = parseQaCommand(comment.body);
      if (!cmd) return none("comment has no /qa command");
      if (cmd.name === "approve" && cmd.version === undefined)
        return none("say which plan version to approve: /qa approve v<N>");
      const ticket = ticketIn([issue.title], options.projectKey);
      const user = comment.user.login;
      // REQ-PLAN-07/AC2: only people with write access approve or revise; anybody else is refused.
      const allowed = TRUSTED_ASSOCIATIONS.has(comment.author_association);
      return {
        trigger: "comment",
        run: allowed && ticket !== undefined,
        reason: allowed
          ? `/qa ${cmd.name} by ${user}`
          : `${user} may not ${cmd.name} plans (needs write access)`,
        ticket,
        mode: cmd.name === "approve" ? "run" : "plan",
        change: { url: issue.pull_request.html_url ?? issue.html_url ?? "" },
        command: { ...cmd, user, allowed },
      };
    }
    if (name === "workflow_dispatch" || name === "repository_dispatch") {
      const parsed = DispatchEvent.safeParse(event ?? {});
      const fields = parsed.success ? { ...parsed.data.inputs, ...parsed.data.client_payload } : {};
      const ticket = key(fields["ticket"]);
      const jira = name === "repository_dispatch";
      if (!ticket) return none(`${jira ? "dispatch" : "manual run"} without a valid ticket`);
      return {
        trigger: jira ? "jira" : "manual",
        run: true,
        reason: jira ? `Jira: ${fields["status"] ?? "status change"}` : "manual run",
        ticket,
        env: safeOrUndefined(nonEmpty(fields["env"])),
        mode: mode(fields["mode"]) ?? (jira ? "plan" : "full"),
      };
    }
    return none(`event ${String(name)} does not start QAJitsu`);
  }
  if (env["GITLAB_CI"] === "true") {
    const source = env["CI_PIPELINE_SOURCE"];
    if (source === "merge_request_event") {
      const labels = (env["CI_MERGE_REQUEST_LABELS"] ?? "").split(",").map((l) => l.trim());
      if (!labels.includes(options.label)) return none(`merge request has no '${options.label}' label`);
      const ticket = ticketIn(
        [env["CI_MERGE_REQUEST_SOURCE_BRANCH_NAME"], env["CI_MERGE_REQUEST_TITLE"]],
        options.projectKey,
      );
      if (!ticket) return none(`no ${options.projectKey} ticket key in the branch or title`);
      return {
        trigger: "label",
        run: true,
        reason: `label ${options.label}`,
        ticket,
        mode: "full",
        change: {
          url: `${String(env["CI_MERGE_REQUEST_PROJECT_URL"])}/-/merge_requests/${String(env["CI_MERGE_REQUEST_IID"])}`,
          sha: env["CI_COMMIT_SHA"],
        },
      };
    }
    if (source === "web" || source === "api" || source === "trigger" || source === "pipeline") {
      const ticket = key(env["QA_TICKET"]);
      const jira = env["QA_TRIGGER"] === "jira";
      return ticket
        ? {
            trigger: jira ? "jira" : "manual",
            run: true,
            reason: jira ? "Jira status change" : "manual run",
            ticket,
            env: safeOrUndefined(nonEmpty(env["QA_ENV"])),
            mode: mode(env["QA_MODE"]) ?? (jira ? "plan" : "full"),
          }
        : none("pipeline without QA_TICKET");
    }
    return none(`pipeline source ${String(source)} does not start QAJitsu`);
  }
  const ticket = key(env["QA_TICKET"]);
  return ticket
    ? {
        trigger: "manual",
        run: true,
        reason: "QA_TICKET set",
        ticket,
        env: safeOrUndefined(nonEmpty(env["QA_ENV"])),
        mode: mode(env["QA_MODE"]) ?? "full",
      }
    : none("not running in a known CI");
}

const changedFiles = (cwd: string, base: string): Promise<string[]> =>
  new Promise((resolve) => {
    execFile("git", ["-C", cwd, "diff", "--name-only", `${base}...HEAD`], { timeout: 30_000 }, (e, out) => {
      resolve(e ? [] : out.split("\n").filter(Boolean));
    });
  });

const globRe = (glob: string): RegExp =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\/?/g, "\u{1F}")
      .replace(/\*/g, "[^/]*")
      .split("\u{1F}")
      .join(".*")}$`,
  );

/**
 * `qajitsu ci detect [--label <name>] [--paths <glob>...]`: prints the trigger as JSON and, on GitHub,
 * writes `run`, `ticket`, `mode`, `env`, `change`, `command` to `$GITHUB_OUTPUT` (REQ-CI-02, REQ-CI-05/AC2).
 */
export async function runCiDetect(
  options: {
    readonly label?: string | undefined;
    readonly paths?: readonly string[] | undefined;
    /** `env`: shell-safe `export KEY='value'` lines instead of JSON. */
    readonly format?: string | undefined;
  },
  io: CommandIO,
  ports: RuntimePorts,
): Promise<number> {
  try {
    const project = await loadProject(io.cwd, ports.project);
    const eventPath = ports.env["GITHUB_EVENT_PATH"];
    const event = eventPath
      ? (JSON.parse(await readFile(eventPath, "utf8")) as Record<string, unknown>)
      : undefined;
    let trigger = detectTrigger(ports.env, event, {
      projectKey: project.config.jira.project_key,
      label: options.label ?? "qa-agent",
    });
    // REQ-CI-05/AC2: only when the change touches the configured paths.
    const base = ports.env["GITHUB_BASE_REF"]
      ? `origin/${ports.env["GITHUB_BASE_REF"]}`
      : ports.env["CI_MERGE_REQUEST_DIFF_BASE_SHA"];
    if (trigger.run && trigger.trigger === "label" && options.paths && options.paths.length > 0 && base) {
      const patterns = options.paths.map(globRe);
      const files = await changedFiles(io.cwd, base);
      if (!files.some((f) => patterns.some((p) => p.test(f))))
        trigger = { ...trigger, run: false, reason: `no changed file matches ${options.paths.join(", ")}` };
    }
    if (options.format !== "env") io.write(`${JSON.stringify(trigger, null, 2)}\n`);
    const output = ports.env["GITHUB_OUTPUT"];
    if (output) {
      const lines: Record<string, string> = {
        run: String(trigger.run),
        ticket: trigger.ticket ?? "",
        mode: trigger.mode ?? "",
        env: trigger.env ?? "",
        change: trigger.change?.url ?? "",
        command: trigger.command?.name ?? "",
        version: trigger.command?.version === undefined ? "" : String(trigger.command.version),
        instruction: trigger.command?.text ?? "",
        user: trigger.command?.user ?? "",
      };
      // Every value is single-line: a newline could append forged outputs (e.g. a second `ticket=`).
      const outputs = Object.entries(lines).map(([k, v]) => `${k}=${v.replace(/[\r\n]+/g, " ")}`);
      await appendFile(output, `${outputs.join("\n")}\n`);
    }
    if (options.format === "env") {
      // For shells (GitLab before_script): KEY='value' with single quotes escaped, safe to `eval`.
      const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
      io.write(
        [
          `QA_RUN=${q(String(trigger.run))}`,
          `QA_TICKET=${q(trigger.ticket ?? "")}`,
          `QA_CHANGE=${q(trigger.change?.url ?? "")}`,
          `QA_MODE=${q(trigger.mode ?? "")}`,
          `QA_ENV=${q(trigger.env ?? "")}`,
        ]
          .map((l) => `export ${l}`)
          .join("\n")
          .concat("\n"),
      );
      return 0;
    }
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
}

/** Marker of the QAJitsu comment of a ticket on a PR/MR (updated in place). */
export const commentMarker = (ticket: string) => `<!-- qajitsu:${ticket} -->`;

/** Link to this pipeline run (artifacts), from the CI environment. */
export function pipelineUrl(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (env["GITHUB_RUN_ID"] && env["GITHUB_REPOSITORY"])
    return `${env["GITHUB_SERVER_URL"] ?? "https://github.com"}/${env["GITHUB_REPOSITORY"]}/actions/runs/${env["GITHUB_RUN_ID"]}`;
  return env["CI_PIPELINE_URL"];
}

const planVersions = async (session: RunSession): Promise<number[]> =>
  (await readdir(session.ws.path("plan")).catch(() => [] as string[]))
    .map((f) => /^plan\.v(\d+)\.md$/.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number)
    .sort((a, b) => a - b);

const latestPlan = async (session: RunSession): Promise<string | undefined> => {
  const versions = (await readdir(session.ws.path("plan")).catch(() => [] as string[]))
    .map((f) => /^plan\.v(\d+)\.md$/.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
  const last = versions.at(-1);
  return last === undefined
    ? undefined
    : readFile(session.ws.path("plan", `plan.v${String(last)}.md`), "utf8");
};

/** What the PR/MR comment says and which status the check gets, from the run's files. */
export async function ciSummary(
  session: RunSession,
  now: () => Date,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ body: string; state: "pending" | "success" | "failure" | "error"; description: string }> {
  const { ws } = session;
  const marker = commentMarker(ws.ticket);
  const link = pipelineUrl(env);
  if (ws.record.data["results"] === undefined) {
    const plan = await latestPlan(session);
    const version = (await planVersions(session)).at(-1);
    if (!plan)
      return {
        body: `${marker}\n**QAJitsu ${ws.ticket}**: no plan yet.`,
        state: "pending",
        description: "no plan yet",
      };
    const approved = ws.record.data["approval"] !== undefined;
    return {
      body: [
        marker,
        `### QAJitsu test plan for ${ws.ticket} (run ${ws.runId})`,
        approved
          ? "Approved; tests are running."
          : `**Waiting for approval.** Comment \`/qa approve v${String(version ?? 1)}\` to run this version, or \`/qa revise <what to change>\` for a new one. New plans are never approved automatically.`,
        "",
        "<details><summary>Plan</summary>",
        "",
        // Fenced, so nothing in the plan (e.g. a line "/qa approve") reads as a command or as markup.
        "~~~~markdown",
        session.masker.maskText(plan).replace(/~~~~/g, "~ ~ ~ ~"),
        "~~~~",
        "",
        "</details>",
        ...(link ? ["", `Pipeline: ${link}`] : []),
      ].join("\n"),
      state: "pending",
      description: approved ? "plan approved, tests running" : "plan waiting for approval",
    };
  }
  const v = await computeVerdict(session, now);
  const code = exitCodeFor(v.cases.map((c) => c.status));
  const counts = v.cases.reduce<Partial<Record<TestStatus, number>>>(
    (acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }),
    {},
  );
  const description = Object.entries(counts)
    .map(([s, n]) => `${String(n)} ${s}`)
    .join(", ");
  return {
    body: [
      marker,
      `### QAJitsu results for ${ws.ticket} (run ${ws.runId})`,
      "",
      v.matrixMd,
      ...(v.ok ? [] : ["", `Publish gates failed: ${v.failed.map((g) => g.gate).join(", ")}`]),
      ...(v.checks.length > 0 ? ["", ...v.checks.map((c) => `- ${c}`)] : []),
      ...(link ? ["", `Evidence and report.html: ${link}`] : []),
    ].join("\n"),
    state: !v.ok ? "error" : code === 0 ? "success" : code === 1 ? "failure" : "error",
    description,
  };
}

/**
 * `qajitsu ci comment <TICKET> --change <PR/MR URL> [--run <id>]`: posts the plan (waiting for approval)
 * or the results as one updatable comment on the PR/MR and sets the `qajitsu/<TICKET>` status check
 * (REQ-CI-03/AC1, REQ-CI-04/AC4). Everything said is computed from files (invariant 6).
 */
export async function runCiComment(
  rawKey: string,
  options: { readonly run?: string | undefined; readonly change: string },
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
): Promise<number> {
  const masker = createMasker();
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const { codeHosts } = buildAdapters(
      session.project,
      {
        fetch: ports.fetch,
        logger: session.logger,
        now: ports.now,
        resolveSecret: (r) => session.resolveSecret(r),
        registerSecret: (v) => {
          masker.register(v);
        },
      },
      ports,
    );
    let host: CodeHost | undefined;
    let target: ChangeTarget | undefined;
    for (const h of Object.values(codeHosts)) {
      const parsed = h.parseChangeUrl(options.change);
      if (parsed && (parsed.kind === "pr" || parsed.kind === "mr")) {
        host = h;
        target = { repo: parsed.repo, kind: parsed.kind, id: parsed.id };
        break;
      }
    }
    if (!host || !target)
      throw new ConfigError(
        "CI_CHANGE_UNKNOWN",
        "The change URL is not a PR/MR of a configured code host.",
        {},
      );
    const summary = await ciSummary(session, ports.now, ports.env);
    const comment = await host.upsertComment?.(target, summary.body, commentMarker(session.ws.ticket));
    const change = await host.resolveChange({ repo: target.repo, kind: target.kind, id: target.id });
    await host.setCommitStatus?.(target.repo, change.headSha, {
      state: summary.state,
      context: `qajitsu/${session.ws.ticket}`,
      description: summary.description,
      targetUrl: pipelineUrl(ports.env),
    });
    session.events.emit("ci", { kind: "system", name: "ci" }, "ci.commented", {
      state: summary.state,
      change: options.change,
    });
    io.write(`${summary.state}: ${summary.description}${comment?.url ? `\n${comment.url}` : ""}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}

/**
 * `qajitsu ci publish-plan <TICKET> [--run <id>]`: posts the latest plan version to the Jira ticket as one
 * updatable comment, so reviewers see it next to the ticket (REQ-CI-03/AC1). It changes nothing about
 * approval: a plan is approved only by a person (REQ-PLAN-07/AC4).
 */
export async function runCiPublishPlan(
  rawKey: string,
  options: { readonly run?: string | undefined },
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
): Promise<number> {
  const masker = createMasker();
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const plan = await latestPlan(session);
    if (plan === undefined)
      throw new ConfigError("PLAN_NOT_FOUND", "This run has no plan yet; run 'qajitsu plan' first.", {});
    const text = masker.maskText(plan);
    if (masker.containsSecret(text))
      throw new ConfigError("PLAN_CONTAINS_SECRET", "The plan contains a secret value.", {});
    const approved = session.ws.record.data["approval"] !== undefined;
    const title = `QAJitsu test plan for ${session.ws.ticket} (run ${session.ws.runId})${approved ? ", approved" : ", waiting for approval"}`;
    const previous = session.ws.record.data["planComment"] as { commentId: string } | undefined;
    const result = await publisherFor(session, ports).publish({
      ticket: session.ws.ticket,
      runId: session.ws.runId,
      comment: {
        adf: {
          type: "doc",
          version: 1,
          content: [
            { type: "paragraph", content: [{ type: "text", text: title, marks: [{ type: "strong" }] }] },
            { type: "codeBlock", attrs: { language: "markdown" }, content: [{ type: "text", text }] },
          ],
        },
        wiki: `*${title}*\n{noformat}\n${text.replace(/\{noformat\}/gi, "{ noformat }")}\n{noformat}`,
      },
      attachments: [],
      ...(previous ? { previous: { commentId: previous.commentId, attachmentNames: [] } } : {}),
    });
    await session.ws.update({
      data: { ...session.ws.record.data, planComment: { commentId: result.commentId } },
    });
    session.events.emit("ci", { kind: "system", name: "ci" }, "plan.published", {
      commentId: result.commentId,
      updated: result.updated,
    });
    io.write(
      `${result.updated ? "Updated" : "Posted"} the plan on ${session.ws.ticket}${result.url ? `: ${result.url}` : ""}\n`,
    );
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}
