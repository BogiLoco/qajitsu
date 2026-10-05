import { copyFile, readFile, readdir } from "node:fs/promises";
import {
  ConfigError,
  QajitsuError,
  createGitRepos,
  createRunWorkspace,
  loadApprovedPlan,
  sha256,
  type RunWorkspace,
} from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import { evaluateFixCheck, type FixCheckCase } from "@qajitsu/verifier";
import { buildAdapters, type RuntimePorts } from "../adapters.js";
import { resolveConfigPath } from "../project.js";
import { openSession, type ModelPorts } from "../session.js";
import type { CommandIO } from "./fetch.js";
import { runApprove, type ReviewPorts } from "./plan.js";
import { runRun, type RunOptions, type RunPorts } from "./run.js";
import { computeVerdict, writeReports } from "./verdict.js";

const SYSTEM = { kind: "system", name: "orchestrator" } as const;

/** What `run.json` of the fix run records about the fix verification (REQ-VER-11). */
export interface FixCheckRecord {
  readonly verified: boolean;
  readonly baseRun: string;
  readonly repo: string;
  readonly baseSha: string;
  readonly fixSha: string;
  readonly cases: readonly FixCheckCase[];
}

const specHash = async (ws: RunWorkspace, caseId: string): Promise<string> =>
  readFile(ws.path("specs", `${caseId}.spec.ts`), "utf8").then(
    (text) => sha256(text),
    () => "missing",
  );

const statusesOf = (ws: RunWorkspace): Readonly<Record<string, string>> =>
  (ws.record.data["results"] ?? {}) as Record<string, string>;

/**
 * `qajitsu run <TICKET> --build --fix-check`: verifies a bug fix (REQ-VER-11). It runs the approved plan on the
 * fix commit (the normal run), then creates a sibling run of the same ticket on the commit the change branched from,
 * reuses the same approved plan (same SHA-256) and the same specs, and builds and runs that version too. The fix is
 * verified only when every case marked `reproduces` FAILED before and PASSED after, with identical specs.
 * Statuses come from each run's own results; this command only compares them (invariant 1).
 *
 * @returns 3 on errors; the fix run's exit code when the fix is verified; otherwise 1 when a reproduction case still
 *   fails with the fix and 2 when the check is not conclusive.
 */
export async function runFixCheck(
  rawKey: string,
  options: RunOptions,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts & RunPorts,
  review: ReviewPorts,
): Promise<number> {
  const masker = createMasker();
  try {
    if (!options.build)
      throw new ConfigError(
        "FIX_CHECK_NEEDS_BUILD",
        "--fix-check builds both versions: use it with --build.",
        {},
      );
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const { ws, project } = session;
    const { plan } = await loadApprovedPlan(ws);
    const reproducing = plan.cases.filter((c) => c.reproduces);
    if (reproducing.length === 0)
      throw new ConfigError(
        "FIX_CHECK_NO_REPRODUCTION",
        "The approved plan has no case marked reproduces: true; plan the reproduction of the bug first.",
        {},
      );
    const alias = project.config.build?.repo ?? "";
    const repo = project.config.repos[alias];
    const fixed = ws.record.repos[alias];
    if (!repo || !fixed)
      throw new ConfigError(
        "BUILD_REPO_NOT_FETCHED",
        `Repository '${alias}' was not fetched for this run.`,
        {},
      );
    const meta = JSON.parse(await readFile(ws.path("repos", `${alias}.change.json`), "utf8")) as {
      change?: { targetBranch?: unknown };
    };
    // A branch name from the code host; mergeBase validates it before git sees it.
    const target =
      typeof meta.change?.targetBranch === "string" ? meta.change.targetBranch : repo.default_ref;

    // The version before the fix: where the change branched from its target branch (REQ-VER-11/AC1).
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
    const host = codeHosts[repo.host];
    if (!host) throw new ConfigError("REPO_UNKNOWN", `Code host '${repo.host}' is not configured.`, {});
    const git = createGitRepos({
      cacheDir: resolveConfigPath(
        project.config.workspace.git_cache ?? "~/.qa-cache/git",
        project.qaDir,
        ports.home,
      ),
      exec: ports.gitExec,
    });
    const cloneUrl = await host.cloneUrl(repo.path);
    const mirror = await git.ensureMirror(repo.host, repo.path, cloneUrl);
    const baseSha = await git.mergeBase(mirror, fixed.sha, target);
    if (baseSha === fixed.sha)
      throw new ConfigError(
        "FIX_CHECK_NO_CHANGE",
        `The change has no commits of its own on top of ${target}.`,
        {},
      );
    io.write(
      `Fix check: ${alias} ${fixed.sha.slice(0, 12)} (fix) against ${baseSha.slice(0, 12)} (before, ${target})\n`,
    );

    // 1. The fix: the normal run of this ticket (writes the specs).
    io.write("\n== With the fix ==\n");
    const fixCode = await runRun(rawKey, { ...options, run: ws.runId }, io, ports);
    if (fixCode === 3) return 3;

    // 2. Before the fix: a sibling run with the same ticket snapshot, approved plan and specs.
    const base = await createRunWorkspace({
      root: ws.root,
      ticket: ws.ticket,
      now: ports.now,
      random: ports.random,
    });
    for (const name of ["ticket.json", "ticket.md"])
      await copyFile(ws.path("ticket", name), base.path("ticket", name)).catch(() => undefined);
    for (const name of ["analysis.json"])
      await copyFile(ws.path(name), base.path(name)).catch(() => undefined);
    for (const name of [`${alias}.diff`, `${alias}.change.json`])
      await copyFile(ws.path("repos", name), base.path("repos", name));
    await git.addWorktree(mirror, baseSha, base.path("repos", alias), cloneUrl);
    await base.update({
      status: "completed",
      stage: "fetch",
      repos: {
        [alias]: {
          host: repo.host,
          path: repo.path,
          sha: baseSha,
          change: `before ${fixed.change ?? fixed.sha}`,
          strategy: "fix-check",
        },
      },
      checkpoints: [{ stage: "fetch", at: ports.now().toISOString() }],
      data: { fixCheckOf: ws.runId },
    });
    session.events.emit("run", SYSTEM, "fix_check.base_created", { baseRun: base.runId, baseSha, target });
    if ((await runApprove(rawKey, { run: base.runId, reuseFrom: ws.runId }, io, ports, review)) !== 0)
      return 3;
    for (const file of await readdir(ws.path("specs")))
      if (file.endsWith(".spec.ts")) await copyFile(ws.path("specs", file), base.path("specs", file));
    io.write("\n== Before the fix ==\n");
    const baseCode = await runRun(rawKey, { ...options, run: base.runId, keep: false }, io, ports);
    if (baseCode === 3) return 3;

    // 3. Compare, from each run's own computed statuses and specs (REQ-VER-11/AC2+AC3).
    const fixRun = await openSession(rawKey, ws.runId, io.cwd, ports, masker);
    const baseRun = await openSession(rawKey, base.runId, io.cwd, ports, masker);
    const after = statusesOf(fixRun.ws);
    const before = statusesOf(baseRun.ws);
    const result = evaluateFixCheck(
      await Promise.all(
        reproducing.map(async (c) => ({
          caseId: c.id,
          before: before[c.id] ?? "missing",
          after: after[c.id] ?? "missing",
          specBefore: await specHash(baseRun.ws, c.id),
          specAfter: await specHash(fixRun.ws, c.id),
        })),
      ),
    );
    const record: FixCheckRecord = {
      verified: result.verified,
      baseRun: base.runId,
      repo: alias,
      baseSha,
      fixSha: fixed.sha,
      cases: result.cases,
    };
    await fixRun.ws.update({ data: { ...fixRun.ws.record.data, fixCheck: record } });
    await baseRun.ws.update({ data: { ...baseRun.ws.record.data, fixCheckOf: ws.runId } });
    fixRun.events.emit("run", SYSTEM, "fix_check.result", { ...record });
    // REQ-VER-11/AC4: the fix run's report shows both results side by side.
    await writeReports(fixRun, await computeVerdict(fixRun, ports.now));
    io.write(
      [
        "",
        `Fix ${result.verified ? "VERIFIED" : "NOT verified"}: before ${baseSha.slice(0, 12)} (run ${base.runId}), with the fix ${fixed.sha.slice(0, 12)} (run ${ws.runId})`,
        ...result.cases.map((c) => `  ${c.caseId}: ${c.before} → ${c.after} · ${c.reason}`),
        `Report: ${fixRun.ws.path("report", "report.html")}`,
        "",
      ].join("\n"),
    );
    if (result.verified) return fixCode;
    return result.cases.some((c) => c.after === "FAILED") ? 1 : 2;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}
