import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ConfigError,
  TicketKeySchema,
  createEventLog,
  fileSink,
  journalTailHash,
  listTickets,
  openRunWorkspace,
  readRunIndex,
  resolveWorkspaceRoot,
  type EventLog,
  type Logger,
  type RunWorkspace,
} from "@qajitsu/core";
import {
  chooseCacheTtl,
  createModelRegistry,
  type CacheTtl,
  type ModelRegistry,
  type ResolvedModel,
} from "@qajitsu/models";
import { createMasker, type Masker } from "@qajitsu/steps";
import { createCliSecretResolver, type RuntimePorts } from "./adapters.js";
import { createCliLogger } from "./logger.js";
import { loadProject, type LoadedProject } from "./project.js";

/** Everything a command needs to work on an existing run. */
export interface RunSession {
  readonly project: LoadedProject;
  readonly ws: RunWorkspace;
  readonly masker: Masker;
  readonly logger: Logger;
  readonly events: EventLog;
  readonly models: ModelRegistry;
  /** Resolves `secret://` references and registers values with the masker. */
  readonly resolveSecret: (reference: string) => Promise<string>;
  /** The command's clock (ports), for timestamps and the day a price applies to. */
  readonly now?: () => Date;
}

/** Ports for model access that tests can replace (mock providers by alias). */
export interface ModelPorts {
  readonly extraModels?: Readonly<Record<string, (model: string) => ResolvedModel["model"]>>;
  /**
   * Run-level model override (configuration layer 5): `qajitsu bench --model <ref> [--role <role>]`.
   * Without a role the model takes every role except an unconfigured auditor, which keeps choosing
   * another model (REQ-VER-06/AC3).
   */
  readonly modelOverride?: { readonly ref: string; readonly role?: string | undefined };
}

/**
 * Applies a run-level model override to the loaded project.
 *
 * @param project - Loaded project.
 * @param override - Model reference and optional role.
 */
export function withModelOverride(
  project: LoadedProject,
  override: ModelPorts["modelOverride"],
): LoadedProject {
  if (!override) return project;
  const roles = { ...project.config.models.roles };
  if (override.role !== undefined) roles[override.role] = override.ref;
  else
    for (const role of ["default", "analyst", "planner", "author", "healer", "explorer", "summary"])
      roles[role] = override.ref;
  return { ...project, config: { ...project.config, models: { ...project.config.models, roles } } };
}

/**
 * Opens a run of a ticket: `--run <id>` or the latest run from `index.json`.
 *
 * @throws {ConfigError} `RUN_NOT_FOUND` when the ticket has no runs.
 */
export async function openSession(
  rawKey: string,
  runId: string | undefined,
  cwd: string,
  ports: RuntimePorts & ModelPorts,
  masker: Masker = createMasker(),
): Promise<RunSession> {
  const key = TicketKeySchema.safeParse(rawKey);
  if (!key.success) {
    throw new ConfigError(
      "TICKET_KEY_INVALID",
      `Invalid ticket key '${rawKey.slice(0, 40)}': expected a Jira key like SHOP-482.`,
      {},
    );
  }
  const project = withModelOverride(await loadProject(cwd, ports.project), ports.modelOverride);
  const root = resolveWorkspaceRoot({
    configured: project.config.workspace.root,
    home: ports.home,
    cwd: project.qaDir,
  });
  const id = runId ?? (await readRunIndex(root, key.data)).latest;
  if (id === undefined) {
    throw new ConfigError(
      "RUN_NOT_FOUND",
      `No run for ${key.data}; start with 'qajitsu fetch ${key.data}'.`,
      { ticket: key.data },
    );
  }
  const ws = await openRunWorkspace(root, key.data, id, ports.now);
  // REQ-PRJ-07/AC1: after `qj work reset` the latest run is closed; only an explicit --run reopens it.
  if (runId === undefined && ws.record.data["closed"] !== undefined)
    throw new ConfigError(
      "RUN_CLOSED",
      `Work on ${key.data} was reset; start a new run with 'qajitsu fetch ${key.data}' (or name the old one with --run).`,
      { run: ws.runId },
    );
  // REQ-PRJ-03/AC6, REQ-PRJ-04: a run is only ever continued in the project it belongs to.
  const owner = ws.record.data["project"];
  if (ports.project && typeof owner === "string" && owner !== ports.project.slug)
    throw new ConfigError(
      "RUN_OTHER_PROJECT",
      `Run ${ws.runId} belongs to project ${owner}, not ${ports.project.slug}; use --project ${owner}.`,
      { run: ws.runId },
    );
  const maskJson = (value: unknown): unknown => masker.maskJson(value);
  const logger = createCliLogger({ file: ws.path("logs", "qajitsu.log"), mask: maskJson });
  const events = createEventLog({
    ticket: key.data,
    run: ws.runId,
    write: fileSink(ws.path("journal", "events.jsonl")),
    // REQ-OBS-05: every process continues the journal's hash chain.
    tail: () => journalTailHash(ws.path("journal", "events.jsonl")),
    now: ports.now,
    mask: maskJson,
  });
  const resolveSecret = createCliSecretResolver(project, ports, masker);
  await registerConfiguredSecrets(project, resolveSecret);
  // REQ-LLM-12/AC2: the prompt cache duration of the run, chosen once and recorded with its reason.
  const cacheTtl = await runCacheTtl(project.config.models.cache_ttl, root, ws, events);
  const models = createModelRegistry({
    config: project.config.models,
    resolveSecret,
    fetch: ports.fetch,
    cacheTtl,
    ...(ports.extraModels ? { extra: ports.extraModels } : {}),
  });
  return { project, ws, masker, logger, events, models, resolveSecret, now: ports.now };
}

/**
 * The prompt cache duration of a run (REQ-LLM-12/AC2): the configured one, or with `auto` the one the project's recent
 * model calls point to. The choice is recorded in `run.json` (`promptCache`) and the journal once per run.
 */
async function runCacheTtl(
  configured: "auto" | "5m" | "1h" | "off",
  root: string,
  ws: RunWorkspace,
  events: EventLog,
): Promise<CacheTtl> {
  const recorded = ws.record.data["promptCache"] as { ttl?: CacheTtl } | undefined;
  if (recorded?.ttl !== undefined && configured === "auto") return recorded.ttl;
  let choice: { ttl: CacheTtl; basis: string };
  if (configured !== "auto") choice = { ttl: configured, basis: "models.cache_ttl" };
  else {
    const times: number[] = [];
    // The latest runs of every ticket of the project, newest first, up to 30.
    const runs: string[] = [];
    for (const ticket of await listTickets(root).catch(() => []))
      for (const r of (await readRunIndex(root, ticket).catch(() => ({ runs: [] }))).runs)
        runs.push(join(root, ticket, r.runId));
    for (const dir of runs.sort().slice(-30)) {
      const text = await readFile(join(dir, "journal", "events.jsonl"), "utf8").catch(() => "");
      for (const line of text.split("\n"))
        if (line.includes('"model.usage"')) {
          const ts = /"ts":"([^"]+)"/.exec(line)?.[1];
          if (ts) times.push(Date.parse(ts));
        }
    }
    choice = chooseCacheTtl(times.filter((t) => !Number.isNaN(t)).slice(-500));
  }
  if (recorded?.ttl !== choice.ttl) {
    await ws.update({ data: { ...ws.record.data, promptCache: choice } });
    events.emit("timing", { kind: "system", name: "orchestrator" }, "models.cache_ttl", choice);
  }
  return choice.ttl;
}

/**
 * Resolves every `secret://` reference in the project configuration up front, so the masker knows
 * all of them before any knowledge file, tool output or error is masked (REQ-CFG-06/AC1).
 * References that cannot be resolved are skipped here; the adapter that needs one fails later.
 */
export async function registerConfiguredSecrets(
  project: LoadedProject,
  resolveSecret: (ref: string) => Promise<string>,
): Promise<void> {
  const refs = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === "string" && value.startsWith("secret://")) refs.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(project.config);
  // Environment profiles hold test account passwords; documents and notes can quote them too.
  const envDir = join(project.qaDir, "envs");
  for (const name of await readdir(envDir).catch(() => [] as string[]))
    if (/\.ya?ml$/.test(name))
      for (const m of (await readFile(join(envDir, name), "utf8").catch(() => "")).matchAll(
        /secret:\/\/[a-z0-9-]+\/[^\s"',}\]]+/g,
      ))
        refs.add(m[0]);
  await Promise.all([...refs].map((ref) => resolveSecret(ref).catch(() => undefined)));
}

/** Path of the project's knowledge folder (REQ-CTX-07). */
export const knowledgeDir = (project: LoadedProject): string => join(project.qaDir, "knowledge");

/** The project's cache of code indexes by `<repo>@<sha>` (REQ-PRJ-08/AC2); undefined outside a project home. */
export const codeIndexCache = (project: LoadedProject): string | undefined =>
  project.project ? join(project.project.paths.cache, "index") : undefined;
