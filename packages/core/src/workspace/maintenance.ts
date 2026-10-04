import { copyFile, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError } from "../errors.js";
import { RunIdSchema, TicketKeySchema, type TicketKey } from "../identifiers.js";
import { readRunIndex, updateRunIndex, type RunIndex, type RunWorkspace } from "./run-workspace.js";

/** Retention settings (`cleanup` in `.qa/qa.project.yaml`, REQ-WS-03/AC2). */
export interface RetentionPolicy {
  readonly keep_last: number;
  readonly max_age_days: number;
}

/**
 * Removes the runtime leftovers of a run inside its folder: repository worktrees under `repos/` and every
 * file under `env/` (REQ-WS-03/AC3, REQ-CFG-05/AC2). Plan, specs, results, evidence, report, logs and
 * journal stay. Symlinks are removed as links, never followed, so nothing outside the run is touched
 * (REQ-WS-03/AC4).
 *
 * @param ws - Run workspace.
 * @returns Paths removed, relative to the run folder.
 */
export async function cleanRunFiles(ws: RunWorkspace): Promise<string[]> {
  const removed: string[] = [];
  for (const entry of await readdir(ws.path("repos")).catch(() => [])) {
    const target = ws.path("repos", entry);
    const info = await lstat(target);
    if (info.isDirectory() || info.isSymbolicLink()) {
      await rm(target, { recursive: info.isDirectory(), force: true });
      removed.push(`repos/${entry}`);
    }
  }
  const envDir = ws.path("env");
  if ((await lstat(envDir).catch(() => undefined))?.isSymbolicLink() === true) {
    // A planted symlink: remove the link, never what it points to.
    await rm(envDir, { force: true });
    return [...removed, "env"];
  }
  for (const entry of await readdir(envDir).catch(() => [])) {
    await rm(ws.path("env", entry), { recursive: true, force: true });
    removed.push(`env/${entry}`);
  }
  return removed;
}

/**
 * Runs of a ticket that retention removes (REQ-WS-03/AC2): beyond the newest `keep_last`, or older
 * than `max_age_days`; runs marked `keep` and running runs are never selected.
 *
 * @param index - Ticket index.
 * @param policy - Retention settings.
 * @param now - Current time.
 */
export function expiredRuns(index: RunIndex, policy: RetentionPolicy, now: Date): string[] {
  const candidates = index.runs
    .filter((r) => r.retention !== "keep" && r.status !== "running")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const cutoff = now.getTime() - policy.max_age_days * 86_400_000;
  return candidates
    .filter((r, i) => i >= policy.keep_last || Date.parse(r.createdAt) < cutoff)
    .map((r) => r.runId);
}

/**
 * Deletes a whole run folder and its index entry; `latest` moves to the newest remaining run.
 *
 * @param root - Workspace root.
 * @param ticket - Ticket key.
 * @param runId - Run id (validated before it is used in a path).
 */
export async function deleteRun(root: string, ticket: TicketKey, runId: string): Promise<void> {
  const id = RunIdSchema.parse(runId);
  await rm(join(root, ticket, id), { recursive: true, force: true });
  await updateRunIndex(root, ticket, (index) => {
    const runs = index.runs.filter((r) => r.runId !== id);
    const latest = index.latest === id ? runs.at(-1)?.runId : index.latest;
    return { ticket: index.ticket, runs, ...(latest === undefined ? {} : { latest }) };
  });
}

/**
 * Tickets that have a run index under the root.
 *
 * @param root - Workspace root.
 */
export async function listTickets(root: string): Promise<TicketKey[]> {
  const out: TicketKey[] = [];
  for (const entry of await readdir(root).catch(() => [])) {
    const ticket = TicketKeySchema.safeParse(entry);
    if (!ticket.success) continue;
    const index = await readRunIndex(root, ticket.data).catch(() => undefined);
    if (index && index.runs.length > 0) out.push(ticket.data);
  }
  return out;
}

/** Folder of archived journals under the workspace root (REQ-OBS-05/AC2). */
export const AUDIT_DIR = ".audit";

/**
 * Copies a run's journal to `<root>/.audit/<ticket>/<run>.events.jsonl` before the run is deleted, so the
 * audit log outlives workspace retention (REQ-OBS-05/AC2).
 *
 * @returns The archive path, or undefined when the run has no journal.
 * @throws When the copy fails; the caller must then keep the run.
 */
export async function archiveJournal(
  root: string,
  ticket: TicketKey,
  runId: string,
): Promise<string | undefined> {
  const id = RunIdSchema.parse(runId);
  const source = join(root, ticket, id, "journal", "events.jsonl");
  if ((await lstat(source).catch(() => undefined))?.isFile() !== true) return undefined;
  const dir = join(root, AUDIT_DIR, ticket);
  await mkdir(dir, { recursive: true });
  for (const d of [join(root, AUDIT_DIR), dir])
    if ((await lstat(d)).isSymbolicLink())
      throw new ConfigError(
        "AUDIT_ARCHIVE_UNSAFE",
        `${d} is a symbolic link; the journal was not archived.`,
        {},
      );
  // Written next to the target and renamed: a planted symlink at the target is replaced, never followed.
  const target = join(dir, `${id}.events.jsonl`);
  const tmp = `${target}.tmp-${String(process.pid)}`;
  await copyFile(source, tmp);
  await rename(tmp, target);
  return target;
}

/**
 * Removes archived journals older than the audit retention (by file modification time).
 *
 * @returns Removed archive paths.
 */
export async function pruneAuditArchive(root: string, retentionDays: number, now: Date): Promise<string[]> {
  const removed: string[] = [];
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  for (const ticket of await readdir(join(root, AUDIT_DIR)).catch(() => [])) {
    if (!TicketKeySchema.safeParse(ticket).success) continue;
    for (const file of await readdir(join(root, AUDIT_DIR, ticket)).catch(() => [])) {
      const path = join(root, AUDIT_DIR, ticket, file);
      const info = await lstat(path);
      if (info.isFile() && file.endsWith(".events.jsonl") && info.mtimeMs < cutoff) {
        await rm(path, { force: true });
        removed.push(path);
      }
    }
  }
  return removed;
}
