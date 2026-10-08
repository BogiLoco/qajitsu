import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ConfigError,
  GateFailedError,
  QajitsuError,
  maskCredentials,
  parseEventLines,
  sha256,
  splitCredentials,
  type CaseResultFile,
  type TestCase,
} from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import { stringify } from "yaml";
import { buildAdapters, type RuntimePorts } from "../adapters.js";
import { openSession, type ModelPorts, type RunSession } from "../session.js";
import type { CommandIO } from "./fetch.js";
import { packCasesSha256 } from "./pack.js";
import { computeVerdict } from "./verdict.js";

/** Options of `qajitsu promote`. */
export interface PromoteOptions {
  readonly run?: string | undefined;
  /** Comma-separated case ids; default: every PASSED case. */
  readonly cases?: string | undefined;
  /** Alias of the tests repository when the project has several. */
  readonly repo?: string | undefined;
  readonly yes?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
}

/** One file of a regression pack, relative to the tests repository. */
interface PackFile {
  readonly path: string;
  readonly text: string;
}

/**
 * The spec that produced a case's PASSED attempt, checked against the SHA-256 the runner recorded when it ran
 * (REQ-PUB-08/AC2): a spec changed after the run is never promoted.
 *
 * @throws {GateFailedError} `SPEC_NOT_VERIFIED` or `SPEC_CHANGED_SINCE_RUN`.
 */
async function passedSpec(
  session: RunSession,
  result: CaseResultFile,
): Promise<{ text: string; sha: string }> {
  const passed = [...result.attempts].reverse().find((a) => a.outcome === "passed");
  if (!passed?.specSha256)
    throw new GateFailedError(
      "SPEC_NOT_VERIFIED",
      `${result.caseId}: the run did not record which spec passed; run the plan again before promoting.`,
      { caseId: result.caseId },
    );
  const file =
    passed.healed === true
      ? session.ws.path("specs", "healed", `v${String(passed.attempt)}`, `${result.caseId}.spec.ts`)
      : (result.spec ?? session.ws.path("specs", `${result.caseId}.spec.ts`));
  // The hash is also in the hash-chained journal, so rewriting results/ alone cannot vouch for another spec.
  const { events } = parseEventLines(await readFile(session.ws.path("journal", "events.jsonl"), "utf8"));
  const started = events.find(
    (e) =>
      e.event === "case.attempt.start" &&
      e.actor.kind === "runner" &&
      (e.details as Record<string, unknown> | undefined)?.["caseId"] === result.caseId &&
      (e.details as Record<string, unknown> | undefined)?.["attempt"] === passed.attempt,
  );
  const journaled = (started?.details as Record<string, unknown> | undefined)?.["specSha256"];
  const bytes = await readFile(file).catch(() => undefined);
  if (!bytes || sha256(bytes) !== passed.specSha256 || journaled !== passed.specSha256)
    throw new GateFailedError(
      "SPEC_CHANGED_SINCE_RUN",
      `${result.caseId}: the spec is not the one that passed in run ${session.ws.runId}.`,
      { caseId: result.caseId },
    );
  return { text: bytes.toString("utf8"), sha: passed.specSha256 };
}

/** Where packs go in the tests repository: `promote_dir`, else `qajitsu/` in its usual tests folder. */
async function packRoot(worktree: string, configured: string | undefined): Promise<string> {
  if (configured !== undefined) return configured.replace(/\/+$/, "");
  for (const dir of ["tests", "test", "e2e", "spec"])
    if ((await stat(join(worktree, dir)).catch(() => undefined))?.isDirectory()) return `${dir}/qajitsu`;
  return "qajitsu";
}

const README = (ticket: string): string => `# QAJitsu regression pack ${ticket}

Promoted from a QAJitsu run with \`qj promote\`. Each \`*.qajitsu.ts\` file is the spec that PASSED against the
approved test plan, unchanged; its expected values are the plan's, in \`expectations.yaml\` with the plan's SHA-256,
the approver and the run. The files run in QAJitsu's sandboxed runner (the \`.qajitsu.ts\` suffix keeps other test
runners away). Do not edit expected values here: change the plan and promote again.
`;

/**
 * `qajitsu promote <TICKET> [--cases TC-01,TC-03]`: proposes the run's PASSED cases as a pull/merge request to the
 * project's tests repository (REQ-PUB-08, REQ-CTX-06/AC4). Statuses and gates come from `computeVerdict`, the same
 * code as publishing; a case is promotable only when it is PASSED and its spec is byte for byte the one that passed.
 * The pack keeps the plan's expectations (`expectations.yaml`) and is scanned for secrets. Nothing is pushed
 * without confirmation (`yes`, or `--yes`); `--dry-run` writes the pack to the project's exports instead.
 *
 * @returns 0 promoted (or written with --dry-run), 2 not confirmed, 3 refused or errors.
 */
export async function runPromote(
  rawKey: string,
  options: PromoteOptions,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
  user: string,
): Promise<number> {
  const masker = createMasker();
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const { ws, project } = session;
    if (ws.record.data["results"] === undefined)
      throw new ConfigError("RUN_NOT_EXECUTED", "This run has no results yet; run 'qajitsu run' first.", {});
    if (ws.record.data["bench"] !== undefined)
      throw new ConfigError("BENCH_RUN_NOT_PROMOTABLE", `Run ${ws.runId} is a benchmark run.`, {});
    const verdict = await computeVerdict(session, ports.now);
    if (!verdict.ok)
      throw new GateFailedError(
        "PROMOTE_GATES_FAILED",
        `Gates failed: ${verdict.failed.map((g) => g.gate).join(", ")}; nothing can be promoted from this run.`,
        { gates: verdict.failed.map((g) => g.gate) },
      );
    const status = new Map(verdict.cases.map((c) => [c.caseId, c.status]));
    const requested = options.cases
      ?.split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    const candidates = requested ?? verdict.plan.cases.map((c) => c.id);
    const refused = candidates
      .map((id) => [id, status.get(id)] as const)
      .filter(([, s]) => s !== "PASSED")
      .map(([id, s]) => `${id}: ${s ?? "not in the approved plan"}`);
    if (requested && refused.length > 0)
      throw new GateFailedError(
        "CASES_NOT_PROMOTABLE",
        `Only PASSED cases can be promoted: ${refused.join("; ")}.`,
        { refused },
      );
    const selected = verdict.plan.cases.filter(
      (c) => candidates.includes(c.id) && status.get(c.id) === "PASSED",
    );
    if (selected.length === 0)
      throw new GateFailedError("NOTHING_TO_PROMOTE", "No PASSED case to promote in this run.", {});

    const testsRepos = Object.entries(ws.record.repos).filter(([, r]) => r.role === "tests");
    const chosen = options.repo ? testsRepos.filter(([alias]) => alias === options.repo) : testsRepos;
    if (chosen.length !== 1 || !chosen[0])
      throw new ConfigError(
        "TESTS_REPO_REQUIRED",
        chosen.length === 0
          ? "No tests repository in this run: declare one with 'repos.<alias>.role: tests' (or check --repo)."
          : `Several tests repositories (${chosen.map(([a]) => a).join(", ")}); choose one with --repo.`,
        {},
      );
    const [alias, record] = chosen[0];
    const repoConfig = project.config.repos[alias];
    const root = `${await packRoot(ws.path("repos", alias), repoConfig?.promote_dir)}/${ws.ticket}`;

    const specs: Record<string, string> = {};
    const files: PackFile[] = [];
    for (const c of selected) {
      const result = verdict.results.get(c.id);
      if (!result) throw new GateFailedError("SPEC_NOT_VERIFIED", `${c.id} has no results file.`, {});
      const spec = await passedSpec(session, result);
      specs[c.id] = spec.sha;
      files.push({ path: `${root}/${c.id}.qajitsu.ts`, text: spec.text });
    }
    const approval = verdict.approval;
    const cases: TestCase[] = selected;
    files.push({
      path: `${root}/expectations.yaml`,
      text: stringify(
        {
          schema: 1,
          kind: "qajitsu-regression-pack",
          ticket: ws.ticket,
          run: ws.runId,
          plan: {
            version: approval.version,
            sha256: approval.sha256,
            approved_by: approval.approver,
            approved_at: approval.at,
          },
          promoted_by: user,
          promoted_at: ports.now().toISOString(),
          specs,
          // REQ-EXEC-17/AC2: `qj regression` checks the expected values against this hash before running.
          cases_sha256: packCasesSha256(cases),
          // REQ-OBS-10/AC3: what the cases passed with, so a regression run can list what changed since.
          ...(ws.record.data["versions"] ? { versions: ws.record.data["versions"] } : {}),
          cases,
        },
        { lineWidth: 0 },
      ),
    });
    files.push({ path: `${root}/README.md`, text: README(ws.ticket) });
    // Nothing that leaves the machine may carry a secret (invariant 8).
    const leaking = files.filter((f) => masker.containsSecret(f.text) || maskCredentials(f.text) !== f.text);
    if (leaking.length > 0)
      throw new GateFailedError(
        "PROMOTE_CONTAINS_SECRET",
        `Not promoted: ${leaking.map((f) => f.path).join(", ")} contain a secret value or a credential.`,
        {},
      );

    const branch = `qajitsu/${ws.ticket.toLowerCase()}-${ws.runId}`;
    const title = `test(${ws.ticket}): promote ${selected.map((c) => c.id).join(", ")} from QAJitsu`;
    const jira = project.config.jira;
    const ticketUrl =
      "base_url" in jira && jira.base_url
        ? `${jira.base_url.replace(/\/+$/, "")}/browse/${ws.ticket}`
        : ws.ticket;
    const body = [
      `Regression cases for ${ticketUrl}, promoted from QAJitsu run \`${ws.runId}\`.`,
      "",
      ...selected.map((c) => `- ${c.id} ${c.title} (PASSED)`),
      "",
      `Approved plan v${String(approval.version)} by ${approval.approver}, sha256 \`${approval.sha256}\`.`,
      "Statuses were computed by QAJitsu from runner output; specs are byte for byte the ones that passed and read",
      "their expected values from `expectations.yaml`.",
    ].join("\n");
    io.write(
      [
        `Promote to ${record.path} (${alias}) on branch ${branch}, ${repoConfig?.default_ref ?? "main"} as target:`,
        ...files.map((f) => `  ${f.path}`),
        ...(!requested && refused.length > 0 ? [`Not promoted (not PASSED): ${refused.join("; ")}`] : []),
        "",
      ].join("\n"),
    );

    if (options.dryRun === true) {
      const out = join(project.project?.paths.exports ?? project.projectDir, ws.ticket, "promote", ws.runId);
      for (const f of files) {
        await mkdir(dirname(join(out, f.path)), { recursive: true });
        await writeFile(join(out, f.path), f.text);
      }
      io.write(`Dry run: nothing pushed; the pack is in ${out}\n`);
      return 0;
    }
    // REQ-PUB-08/AC4: nothing leaves the machine without the user's confirmation.
    if (options.yes !== true) {
      const answer = io.ask
        ? (await io.ask("Push this branch and open a pull request? Type 'yes': ")).trim()
        : "";
      if (answer !== "yes") {
        io.writeError(
          io.ask ? "Nothing pushed.\n" : "Not interactive: nothing pushed; confirm with --yes.\n",
        );
        return 2;
      }
    }

    const { codeHosts } = buildAdapters(
      project,
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
    const host = codeHosts[record.host];
    if (!host)
      throw new ConfigError("CODE_HOST_UNKNOWN", `Code host '${record.host}' is not configured.`, {});
    const git = ports.gitExec;
    const worktree = await mkdtemp(join(tmpdir(), "qj-promote-"));
    const base = ws.path("repos", alias);
    cleanup = async () => {
      await git(["-C", base, "worktree", "remove", "--force", worktree]).catch(() => undefined);
      await rm(worktree, { recursive: true, force: true });
    };
    await git(["-C", base, "worktree", "add", "-q", "-B", branch, worktree, "HEAD"]);
    for (const f of files) {
      await mkdir(dirname(join(worktree, f.path)), { recursive: true });
      await writeFile(join(worktree, f.path), f.text);
    }
    await git(["-C", worktree, "add", "--", root]);
    await git([
      "-C",
      worktree,
      "-c",
      "user.name=QAJitsu",
      "-c",
      "user.email=qajitsu@users.noreply.invalid",
      "commit",
      "-q",
      "-m",
      `${title}\n\nRun ${ws.runId}, plan sha256 ${approval.sha256}.\n\nPromoted-by: ${user}`,
    ]);
    const { url, env } = splitCredentials(await host.cloneUrl(record.path));
    // Re-promoting a run updates its branch, but only over the commit QAJitsu pushed there itself: anything else
    // on that branch (a colleague's fix) is never overwritten.
    const previous = (
      (ws.record.data["promotions"] as { branch?: string; commit?: string }[] | undefined) ?? []
    )
      .filter((x) => x.branch === branch)
      .at(-1)?.commit;
    const remote =
      (await git(["ls-remote", url, `refs/heads/${branch}`], { env })).stdout.split(/\s/)[0] ?? "";
    if (remote !== "" && remote !== previous)
      throw new GateFailedError(
        "PROMOTE_BRANCH_CHANGED",
        `Branch ${branch} in ${record.path} has commits QAJitsu did not push; nothing was overwritten.`,
        {},
      );
    const commit = (await git(["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();
    await git(
      [
        "-C",
        worktree,
        "push",
        "-q",
        `--force-with-lease=refs/heads/${branch}:${remote}`,
        url,
        `HEAD:refs/heads/${branch}`,
      ],
      { env },
    );
    const change = host.openChangeRequest
      ? await host.openChangeRequest({
          repo: record.path,
          sourceBranch: branch,
          targetBranch: repoConfig?.default_ref ?? "main",
          title,
          body,
        })
      : undefined;
    const promotion = {
      at: ports.now().toISOString(),
      by: user,
      repo: alias,
      branch,
      commit,
      cases: selected.map((c) => c.id),
      ...(change ? { change: change.id, url: change.url } : {}),
    };
    const history = (ws.record.data["promotions"] as unknown[] | undefined) ?? [];
    await ws.update({ data: { ...ws.record.data, promotions: [...history, promotion] } });
    session.events.emit("promote", { kind: "user", name: user }, "cases.promoted", promotion);
    io.write(
      change
        ? `${change.created ? "Opened" : "Updated"} ${change.url ?? `change ${change.id}`} with ${String(selected.length)} case(s).\n`
        : `Pushed branch ${branch}; this code host has no pull requests, open one from that branch.\n`,
    );
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    const message = error instanceof Error ? error.message : String(error);
    io.writeError(masker.maskText(`Error${code}: ${message}\n`));
    return 3;
  } finally {
    await cleanup?.();
  }
}
