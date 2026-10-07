import { resolve } from "node:path";
import { createFileBugTracker, createJiraBugTracker } from "@qajitsu/adapter-publish-jira";
import {
  ConfigError,
  GateFailedError,
  QajitsuError,
  keywords,
  maskCredentials,
  readTicketSnapshot,
  type BugMatch,
  type BugTracker,
} from "@qajitsu/core";
import { renderBugReport, type BugReportModel } from "@qajitsu/report";
import { createMasker } from "@qajitsu/steps";
import type { RuntimePorts } from "../adapters.js";
import { openSession, type ModelPorts, type RunSession } from "../session.js";
import type { CommandIO } from "./fetch.js";
import { computeVerdict, type RunVerdict } from "./verdict.js";

/** Options of `qajitsu bug`. */
export interface BugOptions {
  readonly run?: string | undefined;
  /** Comma-separated case ids; default: every FAILED case. */
  readonly cases?: string | undefined;
  /** Link the failure to this existing bug instead of creating one. */
  readonly link?: string | undefined;
  /** Create without asking (still only when no similar open bug is found, unless --force-new). */
  readonly yes?: boolean | undefined;
  readonly forceNew?: boolean | undefined;
}

/** The project's bug tracker: Jira, or ticket files for `jira.type: file`. */
export function bugTrackerFor(session: RunSession, ports: RuntimePorts): BugTracker {
  const { project, ws, masker, logger } = session;
  const jira = project.config.jira;
  if (jira.type === "file")
    return createFileBugTracker(
      resolve(project.qaDir, jira.tickets_dir ?? "tickets"),
      ws.path("report", "bugs"),
    );
  return createJiraBugTracker(
    { flavor: jira.type, baseUrl: jira.base_url ?? "", email: jira.email, token: jira.token ?? "" },
    {
      fetch: ports.fetch,
      logger,
      now: ports.now,
      resolveSecret: session.resolveSecret,
      registerSecret: (v) => {
        masker.register(v);
      },
    },
  );
}

const STOP = new Set([
  "the",
  "and",
  "with",
  "from",
  "after",
  "when",
  "into",
  "that",
  "this",
  "for",
  "not",
  "was",
  "are",
]);

/** The report model of one FAILED case, from the plan, results, manifest and run record only (REQ-PUB-07/AC2+AC3). */
function reportModel(
  session: RunSession,
  verdict: RunVerdict,
  caseId: string,
  hint: string | undefined,
): BugReportModel {
  const { ws, project } = session;
  const planCase = verdict.plan.cases.find((c) => c.id === caseId);
  const evaluated = verdict.cases.find((c) => c.caseId === caseId);
  const last = verdict.results.get(caseId)?.attempts.at(-1);
  const failedSteps = new Set((evaluated?.failures ?? []).map((f) => f.stepId));
  const ranSteps = new Map((last?.steps ?? []).map((s) => [s.id, s]));
  return {
    ticket: ws.ticket,
    runId: ws.runId,
    caseId,
    title: planCase?.title ?? caseId,
    failures: (evaluated?.failures ?? []).map((f) => ({
      stepId: f.stepId,
      field: f.field,
      expected: f.expected,
      actual: f.actual,
    })),
    error: evaluated?.error,
    preconditions: planCase?.preconditions ?? [],
    data: planCase?.data ?? {},
    steps: (planCase?.steps ?? []).map((s) => {
      const ran = ranSteps.get(s.id);
      const outcome = !ran ? "not run" : ran.ok && !failedSteps.has(s.id) ? "ok" : "failed";
      const detail =
        ran?.error ??
        (failedSteps.has(s.id)
          ? (evaluated?.failures ?? [])
              .filter((f) => f.stepId === s.id)
              .map((f) => f.field)
              .join(", ")
          : ran?.url);
      return { id: s.id, action: s.action, outcome, ...(detail ? { detail } : {}) };
    }),
    environment: verdict.environment,
    repos: Object.fromEntries(Object.entries(ws.record.repos).map(([k, v]) => [k, v.sha])),
    ...(planCase?.type === "web" || planCase?.type === "mobile"
      ? { client: planCase.type === "web" ? project.config.web.browser : "android" }
      : {}),
    evidence: (evaluated?.evidence ?? []).map((e) => ({ path: e.path, kind: e.kind, sha256: e.sha256 })),
    hint,
    reproduce: `qajitsu evidence ${ws.ticket} --run ${ws.runId} --failed`,
  };
}

/**
 * `qajitsu bug <TICKET> [--cases TC-01]`: reports FAILED cases as bugs (REQ-PUB-07). For each case it first searches
 * the tracker for similar open bugs and shows them; the user creates a new bug, links the failure to an existing one,
 * or skips (AC1). The report is rendered by code from the run, masked and scanned for secrets (AC2, AC3, AC5); a new
 * bug is linked to the tested ticket. Nothing is created without confirmation; without a terminal only `--yes` or
 * `--link` act (AC4).
 *
 * @returns 0 done, 2 nothing created (declined or similar bugs exist), 3 refused or errors.
 */
export async function runBug(
  rawKey: string,
  options: BugOptions,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
  user: string,
): Promise<number> {
  const masker = createMasker();
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const { ws, project, events } = session;
    if (ws.record.data["results"] === undefined)
      throw new ConfigError("RUN_NOT_EXECUTED", "This run has no results yet; run 'qajitsu run' first.", {});
    if (ws.record.data["bench"] !== undefined)
      throw new ConfigError(
        "BENCH_RUN_NOT_REPORTABLE",
        `Run ${ws.runId} is a benchmark run with seeded bugs.`,
        {},
      );
    const verdict = await computeVerdict(session, ports.now);
    if (!verdict.ok)
      throw new GateFailedError(
        "BUG_GATES_FAILED",
        `Gates failed: ${verdict.failed.map((g) => g.gate).join(", ")}; no bug is reported from this run.`,
        {},
      );
    const status = new Map(verdict.cases.map((c) => [c.caseId, c.status]));
    const requested = options.cases
      ?.split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    const notFailed = (requested ?? []).filter((id) => status.get(id) !== "FAILED");
    if (notFailed.length > 0)
      throw new GateFailedError(
        "CASES_NOT_FAILED",
        `Only FAILED cases are reported as bugs: ${notFailed.map((id) => `${id}: ${status.get(id) ?? "not in the plan"}`).join("; ")}.`,
        {},
      );
    const ids = requested ?? verdict.cases.filter((c) => c.status === "FAILED").map((c) => c.caseId);
    if (ids.length === 0) {
      io.write("No FAILED case in this run.\n");
      return 0;
    }
    if (options.link !== undefined && ids.length !== 1)
      throw new ConfigError("BUG_LINK_ONE_CASE", "--link needs exactly one case (--cases TC-01).", {});
    const hints = new Map(verdict.rows.flatMap((r) => (r.hint ? [[r.caseId, r.hint] as const] : [])));
    const ticket = await readTicketSnapshot(ws.path("ticket", "ticket.json"));
    const tracker = bugTrackerFor(session, ports);
    const previous = (ws.record.data["bugs"] as { caseId: string; key: string }[] | undefined) ?? [];
    let created = 0;
    let declined = 0;
    for (const caseId of ids) {
      const already = previous.find((b) => b.caseId === caseId);
      if (already) {
        io.write(`${caseId}: already reported as ${already.key}.\n`);
        continue;
      }
      const report = renderBugReport(reportModel(session, verdict, caseId, hints.get(caseId)));
      // REQ-PUB-07/AC5: masked, then refused if anything secret-shaped is left.
      const mask = (t: string): string => maskCredentials(masker.maskText(t));
      const draft = {
        project: project.config.jira.project_key,
        summary: mask(report.summary),
        description: {
          adf: masker.maskJson(report.adf),
          wiki: mask(report.wiki),
          text: mask(report.text),
        },
        components: ticket.components,
        labels: ["qajitsu"],
      };
      if (masker.containsSecret(JSON.stringify(draft)))
        throw new GateFailedError(
          "BUG_CONTAINS_SECRET",
          `${caseId}: the bug report would contain a secret value.`,
          {},
        );
      io.write(`\n${caseId}: ${draft.summary}\n${draft.description.text}\n`);
      let matches: readonly BugMatch[] = [];
      if (options.link === undefined) {
        const planCase = verdict.plan.cases.find((c) => c.id === caseId);
        const words = keywords(
          `${planCase?.title ?? ""} ${(verdict.cases.find((c) => c.caseId === caseId)?.failures ?? []).map((f) => f.field.split(".").at(-1) ?? "").join(" ")}`,
        ).filter((w) => w.length >= 3 && !STOP.has(w));
        matches = await tracker.findSimilar({ project: draft.project, components: ticket.components, words });
        if (matches.length > 0)
          io.write(
            `Similar open bugs:\n${matches.map((m) => `  ${m.key} ${m.summary} (${m.status})${m.url ? ` ${m.url}` : ""}`).join("\n")}\n`,
          );
      }
      let action: { kind: "create" } | { kind: "link"; key: string } | { kind: "skip" };
      if (options.link !== undefined) action = { kind: "link", key: options.link };
      else if (io.ask) {
        const answer = (
          await io.ask(
            matches.length > 0
              ? `Create a new bug, or link to an existing one? [c]reate, [l]ink <KEY>, [s]kip: `
              : "Create this bug? [c]reate, [s]kip: ",
          )
        ).trim();
        const link = /^l(?:ink)?\s+([A-Z][A-Z0-9_]+-\d+)$/.exec(answer);
        action = /^c(reate)?$/i.test(answer)
          ? { kind: "create" }
          : link?.[1]
            ? { kind: "link", key: link[1] }
            : { kind: "skip" };
      } else if (options.yes === true && (matches.length === 0 || options.forceNew === true))
        action = { kind: "create" };
      else {
        io.writeError(
          matches.length > 0
            ? `${caseId}: similar open bugs exist; link one with --link <KEY> or create anyway with --yes --force-new.\n`
            : `${caseId}: not interactive; create with --yes.\n`,
        );
        action = { kind: "skip" };
      }
      if (action.kind === "skip") {
        declined += 1;
        continue;
      }
      let record: {
        caseId: string;
        key: string;
        url?: string | undefined;
        created: boolean;
        at: string;
        by: string;
      };
      if (action.kind === "link") {
        await tracker.link(ws.ticket, action.key);
        record = { caseId, key: action.key, created: false, at: ports.now().toISOString(), by: user };
        io.write(`${caseId}: linked ${ws.ticket} to ${action.key}.\n`);
      } else {
        const bug = await tracker.createBug(draft);
        await tracker.link(bug.key, ws.ticket);
        record = {
          caseId,
          key: bug.key,
          url: bug.url,
          created: true,
          at: ports.now().toISOString(),
          by: user,
        };
        io.write(`${caseId}: created ${bug.key}${bug.url ? ` ${bug.url}` : ""}, linked to ${ws.ticket}.\n`);
      }
      created += 1;
      previous.push(record);
      await ws.update({ data: { ...ws.record.data, bugs: [...previous] } });
      events.emit(
        "publish",
        { kind: "user", name: user },
        record.created ? "bug.created" : "bug.linked",
        record,
      );
    }
    return created === 0 && declined > 0 ? 2 : 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}
