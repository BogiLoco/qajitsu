import {
  QajitsuError,
  TicketKeySchema,
  createEventLog,
  createGitRepos,
  createRunWorkspace,
  fetchContext,
  fileSink,
  journalTailHash,
  resolveWorkspaceRoot,
} from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import { buildAdapters, createCliSecretResolver, type RuntimePorts } from "../adapters.js";
import { createCliLogger } from "../logger.js";
import { loadProject, resolveConfigPath } from "../project.js";
import { importTestCases } from "./import-cases.js";

/** Options of `qajitsu fetch`. */
export interface FetchOptions {
  readonly pr?: readonly string[];
  readonly mr?: readonly string[];
  readonly ref?: readonly string[];
}

/** Terminal ports of a command. */
export interface CommandIO {
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly cwd: string;
  /** Asks a question in an interactive terminal; undefined in CI (REQ-CTX-03/AC5). */
  readonly ask?: ((question: string) => Promise<string>) | undefined;
}

/**
 * `qajitsu fetch <TICKET>`: creates a run folder and fills `ticket/` and `repos/` (stage 1 demo).
 *
 * @returns Exit code: 0 on success, 3 on configuration or framework errors (REQ-CTX-01/AC5, REQ-CI-04).
 */
export async function runFetch(
  rawKey: string,
  options: FetchOptions,
  io: CommandIO,
  ports: RuntimePorts,
): Promise<number> {
  const masker = createMasker();
  try {
    const key = TicketKeySchema.safeParse(rawKey);
    if (!key.success) {
      io.writeError(`Invalid ticket key '${rawKey.slice(0, 40)}': expected a Jira key like SHOP-482.\n`);
      return 3;
    }
    const project = await loadProject(io.cwd, ports.project);
    const root = resolveWorkspaceRoot({
      configured: project.config.workspace.root,
      home: ports.home,
      cwd: project.qaDir,
    });
    const ws = await createRunWorkspace({ root, ticket: key.data, now: ports.now, random: ports.random });
    const mask = (value: unknown): unknown => masker.maskJson(value);
    const logger = createCliLogger({ file: ws.path("logs", "qajitsu.log"), mask });
    const events = createEventLog({
      ticket: key.data,
      run: ws.runId,
      write: fileSink(ws.path("journal", "events.jsonl")),
      // REQ-OBS-05: every process continues the journal's hash chain.
      tail: () => journalTailHash(ws.path("journal", "events.jsonl")),
      now: ports.now,
      mask,
    });
    const resolveSecret = createCliSecretResolver(project, ports, masker);
    const deps = {
      fetch: ports.fetch,
      logger,
      now: ports.now,
      resolveSecret,
      registerSecret: (value: string) => {
        masker.register(value);
      },
    };
    const { ticketSource, codeHosts, testCaseSources } = buildAdapters(project, deps, ports);
    const git = createGitRepos({
      cacheDir: resolveConfigPath(
        project.config.workspace.git_cache ?? "~/.qa-cache/git",
        project.qaDir,
        ports.home,
      ),
      exec: ports.gitExec,
    });
    io.write(`Run ${ws.runId} for ${key.data}: ${ws.dir}\n`);
    // REQ-PRJ-03/AC4+AC6: the run belongs to the project it started in.
    if (ports.project) {
      await ws.update({ data: { ...ws.record.data, project: ports.project.slug } });
      events.emit("fetch", { kind: "system", name: "orchestrator" }, "run.project", {
        project: ports.project.slug,
        via: ports.project.via,
      });
    }
    const ask = io.ask;
    const result = await fetchContext({
      workspace: ws,
      ticket: key.data,
      config: project.config,
      ticketSource,
      codeHosts,
      git,
      events,
      logger,
      now: ports.now,
      overrides: { urls: [...(options.pr ?? []), ...(options.mr ?? [])], refs: [...(options.ref ?? [])] },
      ...(ask
        ? {
            askForChange: async (message: string) => {
              const answer = await ask(
                `${message}\nEnter PR/MR URLs or <repo>=<ref> (space separated, empty to stop): `,
              );
              return answer.split(/\s+/).filter((a) => a !== "");
            },
          }
        : {}),
    });
    io.write(`Change discovery: ${result.discovery.strategy}\n`);
    for (const { repoAlias, change } of result.discovery.changes) {
      io.write(`  ${repoAlias}: ${change.kind} ${change.id} @ ${change.headSha.slice(0, 12)}\n`);
    }
    // REQ-CTX-08: existing manual test cases, an extra untrusted planner source.
    await importTestCases({ ws, sources: testCaseSources, events, masker, io, now: ports.now });
    io.write(`Context written to ${ws.dir}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    const issues =
      error instanceof QajitsuError && Array.isArray(error.context["issues"])
        ? (error.context["issues"] as unknown[])
        : [];
    io.writeError(
      masker.maskText(`Error${code}: ${message}\n${issues.map((i) => `  - ${String(i)}\n`).join("")}`),
    );
    return 3;
  }
}
