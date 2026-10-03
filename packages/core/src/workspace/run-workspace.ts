import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { ConfigError } from "../errors.js";
import { RunIdSchema, createRunId, type RunId, type TicketKey } from "../identifiers.js";
import { withFileLock } from "./locks.js";

/** Subfolders of every run folder (REQ-WS-01/AC2). */
export const RUN_SUBDIRS = [
  "ticket",
  "plan",
  "repos",
  "env",
  "logs",
  "specs",
  "results",
  "evidence",
  "journal",
  "report",
] as const;

/** Lifecycle of a run as recorded in `run.json` and `index.json`. */
export const RunLifecycleSchema = z.enum(["created", "running", "completed", "failed"]);

/** Lifecycle state of a run. */
export type RunLifecycle = z.infer<typeof RunLifecycleSchema>;

const RepoRecordSchema = z.strictObject({
  host: z.string(),
  path: z.string(),
  sha: z.string().regex(/^[0-9a-f]{7,64}$/),
  change: z.string().optional(),
  strategy: z.string().optional(),
});

/** Schema of `run.json`: the deterministic checkpoint of one run (REQ-WS-01, invariant 9). */
export const RunRecordSchema = z.strictObject({
  schema: z.literal(1),
  ticket: z.string(),
  runId: RunIdSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  status: RunLifecycleSchema,
  stage: z.string().default("created"),
  /** Repository SHAs analysed and tested in this run, by alias (REQ-CTX-04/AC3). */
  repos: z.record(z.string(), RepoRecordSchema).default({}),
  /** Completed stages, in order; used by `resume` (REQ-WS-04). */
  checkpoints: z.array(z.strictObject({ stage: z.string(), at: z.string() })).default([]),
  /** Free-form, schema-checked data owned by later stages (plan hash, publish ids, ...). */
  data: z.record(z.string(), z.unknown()).default({}),
});

/** Parsed `run.json`. */
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** Fields of `run.json` that callers may change. */
export type RunRecordPatch = Partial<Pick<RunRecord, "status" | "stage" | "repos" | "checkpoints" | "data">>;

const IndexEntrySchema = z.strictObject({
  runId: RunIdSchema,
  createdAt: z.string(),
  status: RunLifecycleSchema,
  /** `keep` marks runs exempt from retention cleanup (REQ-WS-03). */
  retention: z.enum(["default", "keep"]),
});

/** Schema of `<TICKET>/index.json` (REQ-WS-01/AC3). */
export const RunIndexSchema = z.strictObject({
  ticket: z.string(),
  latest: RunIdSchema.optional(),
  runs: z.array(IndexEntrySchema),
});

/** Parsed `<TICKET>/index.json`. */
export type RunIndex = z.infer<typeof RunIndexSchema>;

/** A run folder on disk. */
export interface RunWorkspace {
  readonly root: string;
  readonly ticket: TicketKey;
  readonly runId: RunId;
  /** Absolute path of the run folder. */
  readonly dir: string;
  /** Current content of `run.json`. */
  readonly record: RunRecord;
  /**
   * Absolute path inside the run folder.
   *
   * @throws {ConfigError} `PATH_OUTSIDE_RUN` when the segments escape the run folder.
   */
  path(...segments: string[]): string;
  /** Merges a patch into `run.json` (atomic write) and mirrors the status into `index.json`. */
  update(patch: RunRecordPatch): Promise<RunRecord>;
}

/**
 * Resolves the workspace root (REQ-WS-01/AC4). The default lives in the user's home directory,
 * never inside the project repository, so run data is not committed by accident.
 *
 * @param options - Configured root (absolute, `~/...` or relative to `cwd`), home and current directory.
 * @returns Absolute root directory.
 */
export function resolveWorkspaceRoot(options: {
  readonly configured?: string | undefined;
  readonly home: string;
  readonly cwd: string;
}): string {
  const { configured, home, cwd } = options;
  if (configured === undefined || configured === "") return join(home, ".qa-runs");
  if (configured === "~") return home;
  if (configured.startsWith("~/")) return join(home, configured.slice(2));
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}

const writeJsonAtomic = async (file: string, value: unknown): Promise<void> => {
  const tmp = `${file}.tmp-${String(process.pid)}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, file);
};

const readJson = async (file: string): Promise<unknown> =>
  JSON.parse(await readFile(file, "utf8")) as unknown;

const isErrno = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === code;

/**
 * Reads `<root>/<TICKET>/index.json`; an empty index when the ticket has no runs yet.
 *
 * @param root - Workspace root.
 * @param ticket - Ticket key.
 */
export async function readRunIndex(root: string, ticket: TicketKey): Promise<RunIndex> {
  try {
    return RunIndexSchema.parse(await readJson(join(root, ticket, "index.json")));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { ticket, runs: [] };
    throw error;
  }
}

const writeRunIndex = async (root: string, index: RunIndex): Promise<void> => {
  await writeJsonAtomic(join(root, index.ticket, "index.json"), index);
  const link = join(root, index.ticket, "latest");
  await rm(link, { force: true });
  if (index.latest === undefined) return;
  try {
    await symlink(index.latest, link, "dir");
  } catch {
    // Symlinks may be unavailable (Windows without privileges); index.json `latest` stays authoritative.
  }
};

/**
 * Read-modify-write of `<TICKET>/index.json` under a lock, so parallel runs of one ticket keep every
 * entry (REQ-WS-04/AC2).
 *
 * @param root - Workspace root.
 * @param ticket - Ticket key.
 * @param change - Pure function from the current to the new index.
 */
export async function updateRunIndex(
  root: string,
  ticket: TicketKey,
  change: (index: RunIndex) => RunIndex,
): Promise<RunIndex> {
  await mkdir(join(root, ticket), { recursive: true });
  return withFileLock(join(root, ticket, "index.lock"), async () => {
    const next = change(await readRunIndex(root, ticket));
    await writeRunIndex(root, next);
    return next;
  });
}

const bindWorkspace = (
  root: string,
  ticket: TicketKey,
  runId: RunId,
  initial: RunRecord,
  now: () => Date,
): RunWorkspace => {
  const dir = join(root, ticket, runId);
  let record = initial;
  return {
    root,
    ticket,
    runId,
    dir,
    get record() {
      return record;
    },
    path(...segments) {
      const target = resolve(dir, ...segments);
      const rel = relative(dir, target);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new ConfigError("PATH_OUTSIDE_RUN", "Path points outside the run folder.", { segments });
      }
      return target;
    },
    async update(patch) {
      record = RunRecordSchema.parse({ ...record, ...patch, updatedAt: now().toISOString() });
      await writeJsonAtomic(join(dir, "run.json"), record);
      const status = record.status;
      await updateRunIndex(root, ticket, (index) => ({
        ...index,
        runs: index.runs.map((entry) => (entry.runId === runId ? { ...entry, status } : entry)),
      }));
      return record;
    },
  };
};

/**
 * Creates a new run folder with all subfolders, `run.json` and an updated ticket index (REQ-WS-01).
 *
 * @param options - Workspace root, validated ticket key and injected clock and randomness.
 * @returns The new run workspace.
 * @example
 * const ws = await createRunWorkspace({ root, ticket, now: () => new Date(), random: Math.random });
 * await writeFile(ws.path("ticket", "ticket.json"), json);
 */
export async function createRunWorkspace(options: {
  readonly root: string;
  readonly ticket: TicketKey;
  readonly now: () => Date;
  readonly random: () => number;
}): Promise<RunWorkspace> {
  const { root, ticket, now, random } = options;
  await mkdir(join(root, ticket), { recursive: true });
  const createdAt = now();
  let runId = createRunId(createdAt, random);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(join(root, ticket, runId));
      break;
    } catch (error) {
      if (!isErrno(error, "EEXIST") || attempt >= 20) throw error;
      runId = createRunId(createdAt, random);
    }
  }
  const dir = join(root, ticket, runId);
  await Promise.all(RUN_SUBDIRS.map((sub) => mkdir(join(dir, sub))));
  const iso = createdAt.toISOString();
  const record = RunRecordSchema.parse({
    schema: 1,
    ticket,
    runId,
    createdAt: iso,
    updatedAt: iso,
    status: "created",
  });
  await writeJsonAtomic(join(dir, "run.json"), record);
  await updateRunIndex(root, ticket, (index) => ({
    ticket,
    latest: runId,
    runs: [...index.runs, { runId, createdAt: iso, status: "created", retention: "default" }],
  }));
  return bindWorkspace(root, ticket, runId, record, now);
}

/**
 * Opens an existing run folder.
 *
 * @param root - Workspace root.
 * @param ticket - Ticket key.
 * @param runId - Run id; validated before it is used in a path.
 * @param now - Clock used for `updatedAt`.
 * @throws {ConfigError} `RUN_NOT_FOUND` when the run does not exist.
 */
export async function openRunWorkspace(
  root: string,
  ticket: TicketKey,
  runId: string,
  now: () => Date = () => new Date(),
): Promise<RunWorkspace> {
  const id = RunIdSchema.parse(runId);
  try {
    const record = RunRecordSchema.parse(await readJson(join(root, ticket, id, "run.json")));
    return bindWorkspace(root, ticket, id, record, now);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new ConfigError("RUN_NOT_FOUND", `Run ${id} of ${ticket} does not exist.`, { ticket, runId: id });
    }
    throw error;
  }
}
