import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { removeRunResources, type CommandExec } from "@qajitsu/adapter-env-compose";
import {
  ConfigError,
  QajitsuError,
  TicketKeySchema,
  acquireRunLock,
  archiveJournal,
  pruneAuditArchive,
  cleanRunFiles,
  deleteRun,
  expiredRuns,
  listTickets,
  openRunWorkspace,
  readRunIndex,
  resolveWorkspaceRoot,
  type RunRecord,
  type TicketKey,
} from "@qajitsu/core";
import type { RuntimePorts } from "../adapters.js";
import { loadProject, type LoadedProject } from "../project.js";
import type { CommandIO } from "./fetch.js";

/** Root of the run folders of a loaded project. */
export const rootOf = (project: LoadedProject, ports: RuntimePorts): string =>
  resolveWorkspaceRoot({ configured: project.config.workspace.root, home: ports.home, cwd: project.qaDir });

const ticketOf = (raw: string): TicketKey => {
  const key = TicketKeySchema.safeParse(raw);
  if (!key.success)
    throw new ConfigError("TICKET_KEY_INVALID", `Invalid ticket key '${raw.slice(0, 40)}'.`, {});
  return key.data;
};

const fail = (io: CommandIO, error: unknown): number => {
  const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
  io.writeError(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`);
  return 3;
};

/**
 * `qajitsu runs <TICKET>`: the runs of a ticket with status, last stage and results (REQ-WS-04/AC1).
 */
export async function runRuns(rawKey: string, io: CommandIO, ports: RuntimePorts): Promise<number> {
  try {
    const project = await loadProject(io.cwd, ports.project);
    const root = rootOf(project, ports);
    const ticket = ticketOf(rawKey);
    const index = await readRunIndex(root, ticket);
    if (index.runs.length === 0) {
      io.write(`No runs for ${ticket}.\n`);
      return 0;
    }
    io.write("| Run | Created | Status | Stage | Results | Retention |\n|---|---|---|---|---|---|\n");
    for (const entry of index.runs) {
      const ws = await openRunWorkspace(root, ticket, entry.runId).catch(() => undefined);
      const results = ws?.record.data["results"] as Record<string, string> | undefined;
      const counts = results
        ? Object.entries(
            Object.values(results).reduce<Record<string, number>>(
              (acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }),
              {},
            ),
          )
            .map(([s, n]) => `${String(n)} ${s}`)
            .join(", ")
        : "–";
      const latest = entry.runId === index.latest ? " (latest)" : "";
      io.write(
        `| ${entry.runId}${latest} | ${entry.createdAt} | ${entry.status} | ${ws?.record.stage ?? "?"} | ${counts} | ${entry.retention} |\n`,
      );
    }
    return 0;
  } catch (error) {
    return fail(io, error);
  }
}

/** The stage `resume` continues with, from the checkpoints in `run.json` (REQ-WS-04/AC3). */
export type ResumeStep =
  | { readonly next: "fetch-again"; readonly reason: string }
  | { readonly next: "plan" }
  | { readonly next: "approve"; readonly reason: string }
  | { readonly next: "run" }
  | { readonly next: "publish"; readonly reason: string }
  | { readonly next: "done"; readonly reason: string };

/**
 * Decides the next stage of a run from its checkpoints and files.
 *
 * @param record - `run.json`.
 * @param planVersions - Number of plan versions written.
 */
export function nextStage(record: RunRecord, planVersions: number): ResumeStep {
  const done = new Set(record.checkpoints.map((c) => c.stage));
  if (!done.has("fetch"))
    return { next: "fetch-again", reason: "fetch did not complete; start a new run with 'qajitsu fetch'." };
  if (!done.has("approve")) {
    if (planVersions === 0) return { next: "plan" };
    return { next: "approve", reason: "a plan is waiting for review; approve it with 'qajitsu approve'." };
  }
  if (!done.has("run")) return { next: "run" };
  if (!done.has("publish"))
    return { next: "publish", reason: "results are ready; publish them with 'qajitsu publish'." };
  return { next: "done", reason: "the run is complete and published." };
}

/**
 * `qajitsu resume <TICKET> [--run]`: continues a run from its last checkpoint (REQ-WS-04/AC3). Human
 * gates (approval, publish preview) are never skipped: resume stops there and says what to do.
 *
 * @param continueWith - Starts `plan` or `run` on the same run.
 */
export async function runResume(
  rawKey: string,
  options: { readonly run?: string | undefined },
  io: CommandIO,
  ports: RuntimePorts,
  continueWith: (stage: "plan" | "run", runId: string) => Promise<number>,
): Promise<number> {
  try {
    const project = await loadProject(io.cwd, ports.project);
    const root = rootOf(project, ports);
    const ticket = ticketOf(rawKey);
    const runId = options.run ?? (await readRunIndex(root, ticket)).latest;
    if (runId === undefined)
      throw new ConfigError(
        "RUN_NOT_FOUND",
        `No run for ${ticket}; start with 'qajitsu fetch ${ticket}'.`,
        {},
      );
    const ws = await openRunWorkspace(root, ticket, runId);
    const versions = (await readdir(ws.path("plan")).catch(() => [])).filter((f) =>
      /^plan\.v\d+\.yaml$/.test(f),
    );
    const step = nextStage(ws.record, versions.length);
    io.write(`Run ${ws.runId}: last stage ${ws.record.stage} (${ws.record.status}); next: ${step.next}\n`);
    if (step.next === "plan" || step.next === "run") return await continueWith(step.next, ws.runId);
    io.write(`${step.reason}\n`);
    return step.next === "done" ? 0 : 2;
  } catch (error) {
    return fail(io, error);
  }
}

/**
 * Cleans one run's runtime resources unless another process holds it; `then` runs before the lock is
 * released (gc deletes the run under the same lock).
 */
async function cleanOne(
  root: string,
  ticket: TicketKey,
  runId: string,
  exec: CommandExec | undefined,
  then?: () => Promise<void>,
): Promise<string> {
  const ws = await openRunWorkspace(root, ticket, runId);
  let release: () => Promise<void>;
  try {
    release = await acquireRunLock(ws.path("run.lock"));
  } catch {
    return `${runId}: in use by another process, skipped`;
  }
  try {
    const removed = await removeRunResources(ws.runId, exec);
    const files = await cleanRunFiles(ws);
    await then?.();
    return `${runId}: ${String(removed.containers)} container(s), ${String(removed.volumes)} volume(s), ${String(removed.networks)} network(s), ${String(files.length)} worktree/env path(s) removed`;
  } finally {
    await release();
  }
}

/**
 * `qajitsu clean <TICKET> [--run <id>] [--all]`: removes containers, volumes, networks (by QAJitsu
 * labels only), worktrees and `.env` files of a run; plan, specs, results, evidence, report and
 * journal stay (REQ-WS-03/AC3, AC4; REQ-WS-04/AC1).
 */
export async function runClean(
  rawKey: string,
  options: { readonly run?: string | undefined; readonly all?: boolean | undefined },
  io: CommandIO,
  ports: RuntimePorts & { readonly buildExec?: CommandExec },
): Promise<number> {
  try {
    const project = await loadProject(io.cwd, ports.project);
    const root = rootOf(project, ports);
    const ticket = ticketOf(rawKey);
    const index = await readRunIndex(root, ticket);
    const ids = options.all === true ? index.runs.map((r) => r.runId) : [options.run ?? index.latest ?? ""];
    if (ids.length === 0 || ids[0] === "")
      throw new ConfigError("RUN_NOT_FOUND", `No run for ${ticket}.`, {});
    for (const id of ids) io.write(`${await cleanOne(root, ticket, id, ports.buildExec)}\n`);
    return 0;
  } catch (error) {
    return fail(io, error);
  }
}

/**
 * `qajitsu gc [--dry-run]`: applies retention to every ticket (`cleanup.keep_last`, `max_age_days`;
 * runs marked keep and running runs are exempt) and removes the selected runs with their resources
 * (REQ-WS-03/AC2, REQ-WS-04/AC1). Only folders under the workspace root are touched.
 */
export async function runGc(
  options: { readonly dryRun?: boolean | undefined },
  io: CommandIO,
  ports: RuntimePorts & { readonly buildExec?: CommandExec },
): Promise<number> {
  try {
    const project = await loadProject(io.cwd, ports.project);
    const root = rootOf(project, ports);
    let count = 0;
    for (const ticket of await listTickets(root)) {
      for (const runId of expiredRuns(
        await readRunIndex(root, ticket),
        project.config.cleanup,
        ports.now(),
      )) {
        count += 1;
        if (options.dryRun === true) {
          io.write(`would remove ${ticket}/${runId}\n`);
          continue;
        }
        try {
          const cleaned = await cleanOne(root, ticket, runId, ports.buildExec, async () => {
            // REQ-OBS-05/AC2: the journal outlives the run under the audit retention; no archive, no delete.
            await archiveJournal(root, ticket, runId);
            await deleteRun(root, ticket, runId);
          });
          io.write(cleaned.endsWith("skipped") ? `${ticket}/${cleaned}\n` : `removed ${ticket}/${runId}\n`);
        } catch (error) {
          io.writeError(
            `${ticket}/${runId}: kept, its journal could not be archived (${error instanceof Error ? error.message : String(error)})\n`,
          );
        }
      }
    }
    if (options.dryRun !== true) {
      const pruned = await pruneAuditArchive(root, project.config.audit.retention_days, ports.now());
      if (pruned.length > 0)
        io.write(`${String(pruned.length)} archived journal(s) past audit retention removed\n`);
    }
    io.write(
      `${String(count)} run(s) ${options.dryRun === true ? "selected" : "processed"} under ${join(root)}\n`,
    );
    return 0;
  } catch (error) {
    return fail(io, error);
  }
}
