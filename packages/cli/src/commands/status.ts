import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ConfigError,
  QajitsuError,
  RunRecordSchema,
  TicketKeySchema,
  listProjects,
  projectPaths,
  qajitsuHome,
  readKnowledgeIndex,
  readKnowledgeSources,
  readRunIndex,
  type ResolvedProject,
  type RunRecord,
  type TicketKey,
} from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import { z } from "zod";
import { createCliSecretResolver, type RuntimePorts } from "../adapters.js";
import { projectChecks } from "../doctor-project.js";
import { loadProject, type LoadedProject } from "../project.js";
import { registerConfiguredSecrets } from "../session.js";
import type { CommandIO } from "./fetch.js";
import { nextStage, rootOf } from "./runs.js";

/** One ticket with unfinished work (REQ-PRJ-05/AC2). */
export interface OpenWork {
  readonly ticket: string;
  readonly runId: string;
  /** Pipeline stage of the latest run, from `run.json`. */
  readonly stage: string;
  /** Human-readable state, e.g. "plan v2 waiting for approval". */
  readonly state: string;
  /** The command that continues it. */
  readonly next: string;
  readonly notes: readonly Note[];
}

const NoteSchema = z.strictObject({ at: z.string(), by: z.string(), text: z.string().max(2000) });
/** A note attached to a ticket (REQ-PRJ-05/AC4). */
export type Note = z.infer<typeof NoteSchema>;

const notesFile = (root: string, ticket: TicketKey): string => join(root, ticket, "notes.json");

const readNotes = async (root: string, ticket: TicketKey): Promise<Note[]> => {
  const text = await readFile(notesFile(root, ticket), "utf8").catch(() => undefined);
  if (text === undefined) return [];
  const parsed = z.array(NoteSchema).safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : [];
};

const countStatuses = (results: unknown): string => {
  const counts = new Map<string, number>();
  for (const s of Object.values((results ?? {}) as Record<string, string>))
    counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts].map(([s, n]) => `${String(n)} ${s}`).join(", ");
};

/**
 * Describes the state of a ticket's latest run and the command that continues it, computed by code from `run.json`
 * (REQ-PRJ-05/AC2+AC3). `undefined` when the work is done.
 */
export function describeRun(
  ticket: string,
  record: RunRecord,
  planVersions: number,
): { readonly stage: string; readonly state: string; readonly next: string } | undefined {
  if (record.data["closed"] !== undefined) return undefined;
  const step = nextStage(record, planVersions);
  const run = `--run ${record.runId}`;
  if (record.status === "running" && step.next !== "done")
    return {
      stage: record.stage,
      state: `interrupted during ${record.stage}`,
      next: `qajitsu resume ${ticket} ${run}`,
    };
  switch (step.next) {
    case "fetch-again":
      return { stage: "fetch", state: "fetch did not complete", next: `qajitsu fetch ${ticket}` };
    case "plan":
      return { stage: "plan", state: "fetched, no plan yet", next: `qajitsu plan ${ticket} ${run}` };
    case "approve":
      return {
        stage: "plan",
        state: `plan v${String(planVersions)} waiting for approval`,
        next: `qajitsu approve ${ticket} ${run}`,
      };
    case "run":
      return { stage: "approve", state: "plan approved, not run", next: `qajitsu run ${ticket} ${run}` };
    case "publish":
      return {
        stage: "run",
        state: `results not published (${countStatuses(record.data["results"]) || "no results"})`,
        next: `qajitsu publish ${ticket} ${run}`,
      };
    case "done":
      return undefined;
  }
}

/**
 * Open work of a project: the latest run of every ticket that is not done, with its notes (REQ-PRJ-05/AC2+AC4).
 *
 * @returns Open work and the number of tickets whose latest run is done.
 */
export async function openWorkOf(
  project: LoadedProject,
  ports: RuntimePorts,
): Promise<{ open: OpenWork[]; done: number }> {
  const root = rootOf(project, ports);
  const open: OpenWork[] = [];
  let done = 0;
  for (const name of (await readdir(root).catch(() => [] as string[])).sort()) {
    const key = TicketKeySchema.safeParse(name);
    if (!key.success) continue;
    const latest = (await readRunIndex(root, key.data).catch(() => undefined))?.latest;
    if (latest === undefined) continue;
    const parsed = RunRecordSchema.safeParse(
      JSON.parse(await readFile(join(root, key.data, latest, "run.json"), "utf8").catch(() => "null")),
    );
    if (!parsed.success) continue;
    const versions = (await readdir(join(root, key.data, latest, "plan")).catch(() => [] as string[])).filter(
      (f) => /^plan\.v\d+\.yaml$/.test(f),
    ).length;
    const state = describeRun(key.data, parsed.data, versions);
    if (!state) {
      done += 1;
      continue;
    }
    open.push({ ticket: key.data, runId: latest, ...state, notes: await readNotes(root, key.data) });
  }
  return { open, done };
}

/** Summary of a project's knowledge base (REQ-PRJ-05/AC1, REQ-KNOW-05/AC3), from `sources.yaml` and `index.json`. */
async function knowledgeSummary(project: LoadedProject): Promise<string> {
  const dir = project.project?.paths.knowledge;
  if (dir === undefined) return "not available";
  const sources = await readKnowledgeSources(dir).catch(() => []);
  if (sources.length === 0) return "empty (add documents with 'qajitsu knowledge add')";
  const index = await readKnowledgeIndex(dir);
  const synced = sources
    .map((s) => s.synced_at ?? "")
    .sort()
    .at(-1);
  return [
    `${String(sources.length)} source(s)`,
    `mode ${index?.mode ?? "not built"}`,
    ...(index?.embedding ? [`embedding ${index.embedding}`] : []),
    `last sync ${synced ? synced.slice(0, 16).replace("T", " ") : "never"}`,
  ].join(", ");
}

const renderWork = (open: readonly OpenWork[], done: number): string[] => [
  open.length === 0 ? "Work in progress: none" : `Work in progress (${String(open.length)}):`,
  ...open.flatMap((w) => [
    `  ${w.ticket}  run ${w.runId}  ${w.state}`,
    `      next: ${w.next}`,
    ...w.notes.slice(-3).map((n) => `      note (${n.at.slice(0, 10)}, ${n.by}): ${n.text}`),
  ]),
  ...(done > 0 ? [`Done: ${String(done)} ticket(s)`] : []),
];

/** Status lines of one project and its index for `context.json` (REQ-PRJ-05/AC1+AC3). */
async function projectStatus(project: LoadedProject, ports: RuntimePorts): Promise<string[]> {
  const problems = (await projectChecks(project, ports, { online: false })).filter((c) => !c.ok);
  const { open, done } = await openWorkOf(project, ports);
  if (project.project) {
    // context.json is only an index of what was computed here; it is rebuilt on every status.
    const file = project.project.paths.context;
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${String(process.pid)}`;
    await writeFile(
      tmp,
      `${JSON.stringify({ schema: 1, generated_at: ports.now().toISOString(), open, done }, null, 2)}\n`,
    );
    await rename(tmp, file);
  }
  return [
    `Configuration: ${problems.length === 0 ? "ready" : `not ready (${problems.map((p) => p.name).join(", ")})`} · ${project.qaDir}`,
    `Default environment: ${project.config.environments.default ?? "(none: pass --env)"}`,
    `Knowledge base: ${await knowledgeSummary(project)}`,
    ...renderWork(open, done),
  ];
}

const fail = (io: CommandIO, error: unknown): number => {
  const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
  io.writeError(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`);
  return 3;
};

/**
 * `qajitsu status [--all]`: configuration readiness, default environment, knowledge base and open work with the
 * next command per ticket (REQ-PRJ-05). Everything is computed from the run folders; `context.json` is rewritten as
 * an index on every call, so `--rebuild` only says so explicitly.
 *
 * @returns 0, or 3 on errors.
 */
export async function runStatus(
  options: { readonly all?: boolean | undefined; readonly rebuild?: boolean | undefined },
  io: CommandIO,
  ports: RuntimePorts,
): Promise<number> {
  try {
    if (options.all !== true) {
      const project = await loadProject(io.cwd, ports.project);
      io.write(`${(await projectStatus(project, ports)).join("\n")}\n`);
      if (options.rebuild === true) io.write("context.json rebuilt from the run folders.\n");
      return 0;
    }
    const home = qajitsuHome(ports.env, ports.home);
    const records = await listProjects(home);
    if (records.length === 0) io.write("No projects yet: create one with 'qajitsu init <slug>'.\n");
    for (const record of records) {
      const resolved: ResolvedProject = {
        slug: record.slug,
        record,
        paths: projectPaths(home, record.slug),
        via: "--all",
      };
      io.write(`\n== ${record.slug} ==\n`);
      try {
        const project = await loadProject(dirname(record.qa_dir), resolved);
        io.write(`${(await projectStatus(project, { ...ports, project: resolved })).join("\n")}\n`);
      } catch (error) {
        io.write(`Configuration: not ready (${error instanceof Error ? error.message : "unknown error"})\n`);
      }
    }
    return 0;
  } catch (error) {
    return fail(io, error);
  }
}

/**
 * `qajitsu note <TICKET> "<text>"`: attaches a note to a ticket, kept next to its runs and shown by `status`
 * (REQ-PRJ-05/AC4). Known secrets in the text are masked before it is stored.
 *
 * @returns 0, or 3 on errors.
 */
export async function runNote(
  rawKey: string,
  text: string,
  io: CommandIO,
  ports: RuntimePorts,
  user: string,
): Promise<number> {
  try {
    const key = TicketKeySchema.safeParse(rawKey);
    if (!key.success)
      throw new ConfigError("TICKET_KEY_INVALID", `Invalid ticket key '${rawKey.slice(0, 40)}'.`, {});
    if (text.trim() === "") throw new ConfigError("NOTE_EMPTY", "The note is empty.", {});
    const project = await loadProject(io.cwd, ports.project);
    const masker = createMasker();
    await registerConfiguredSecrets(project, createCliSecretResolver(project, ports, masker));
    const root = rootOf(project, ports);
    const notes = await readNotes(root, key.data);
    notes.push({
      at: ports.now().toISOString(),
      by: user,
      text: masker.maskText(text.trim()).slice(0, 2000),
    });
    await mkdir(join(root, key.data), { recursive: true });
    const file = notesFile(root, key.data);
    const tmp = `${file}.tmp-${String(process.pid)}`;
    await writeFile(tmp, `${JSON.stringify(notes, null, 2)}\n`);
    await rename(tmp, file);
    io.write(`Note added to ${key.data} (${String(notes.length)} note(s)).\n`);
    return 0;
  } catch (error) {
    return fail(io, error);
  }
}

/**
 * `qajitsu resume` without a ticket: lists the resumable work of the project with the command for each
 * (REQ-PRJ-06/AC1).
 *
 * @returns 0, or 3 on errors.
 */
export async function runResumable(io: CommandIO, ports: RuntimePorts): Promise<number> {
  try {
    const project = await loadProject(io.cwd, ports.project);
    const { open } = await openWorkOf(project, ports);
    io.write(
      open.length === 0
        ? "Nothing to resume.\n"
        : `${open.map((w) => `${w.ticket}: ${w.state}\n  ${w.next}`).join("\n")}\n`,
    );
    return 0;
  } catch (error) {
    return fail(io, error);
  }
}
