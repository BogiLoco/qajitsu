import { join } from "node:path";
import {
  ConfigError,
  TicketKeySchema,
  createEventLog,
  fileSink,
  openRunWorkspace,
  readRunIndex,
  resolveWorkspaceRoot,
  type EventLog,
  type Logger,
  type RunWorkspace,
} from "@qajitsu/core";
import { createModelRegistry, type ModelRegistry, type ResolvedModel } from "@qajitsu/models";
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
}

/** Ports for model access that tests can replace (mock providers by alias). */
export interface ModelPorts {
  readonly extraModels?: Readonly<Record<string, (model: string) => ResolvedModel["model"]>>;
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
  const project = await loadProject(cwd);
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
  const maskJson = (value: unknown): unknown => masker.maskJson(value);
  const logger = createCliLogger({ file: ws.path("logs", "qajitsu.log"), mask: maskJson });
  const events = createEventLog({
    ticket: key.data,
    run: ws.runId,
    write: fileSink(ws.path("journal", "events.jsonl")),
    now: ports.now,
    mask: maskJson,
  });
  const resolveSecret = createCliSecretResolver(project, ports, masker);
  await registerConfiguredSecrets(project, resolveSecret);
  const models = createModelRegistry({
    config: project.config.models,
    resolveSecret,
    fetch: ports.fetch,
    ...(ports.extraModels ? { extra: ports.extraModels } : {}),
  });
  return { project, ws, masker, logger, events, models, resolveSecret };
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
  await Promise.all([...refs].map((ref) => resolveSecret(ref).catch(() => undefined)));
}

/** Path of the project's knowledge folder (REQ-CTX-07). */
export const knowledgeDir = (project: LoadedProject): string => join(project.qaDir, "knowledge");
