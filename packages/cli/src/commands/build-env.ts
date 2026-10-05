import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  BuildStartError,
  createComposeEnvProvider,
  type BuildEnvironment,
  type CommandExec,
} from "@qajitsu/adapter-env-compose";
import { createLocalEvidenceStore } from "@qajitsu/adapter-evidence-local";
import {
  CaseResultFileSchema,
  ConfigError,
  checkBuildConfig,
  cleanRunFiles,
  type CaseResultFile,
  type ResolvedEnvironment,
} from "@qajitsu/core";
import type { RunSession } from "../session.js";

/** A `--build` environment as `qj run` sees it. */
export interface PreparedBuild {
  readonly build?: BuildEnvironment;
  /** Start failure: every case becomes BLOCKED with these logs (REQ-ENV-04/AC3). */
  readonly failure?: { readonly message: string; readonly logs: readonly string[] };
}

/**
 * Parses `--set <service>.<VAR>=<value>` run overrides (configuration layer 5, REQ-CFG-01, REQ-CFG-02/AC3).
 *
 * @throws {ConfigError} `OVERRIDE_INVALID`.
 */
export function parseOverrides(values: readonly string[]): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const v of values) {
    const m = /^([a-z][a-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(v);
    if (!m)
      throw new ConfigError("OVERRIDE_INVALID", `--set expects <service>.<VAR>=<value>, got '${v}'.`, {});
    const [, service = "", name = "", value = ""] = m;
    out[service] = { ...out[service], [name]: value };
  }
  return out;
}

/**
 * Validates the configuration and starts the application from the run's worktree (REQ-CFG-04/AC2,
 * REQ-CTX-04/AC4, REQ-ENV-03). A configuration problem is an error (exit code 3); a start failure is
 * returned so that every case is recorded BLOCKED with the service logs.
 *
 * @throws {ConfigError} `BUILD_NOT_CONFIGURED`, `BUILD_REPO_NOT_FETCHED`, `ENV_CONFIG_INVALID`.
 */
export async function prepareBuild(
  session: RunSession,
  options: {
    readonly overrides: Readonly<Record<string, Record<string, string>>>;
    readonly exec?: CommandExec | undefined;
    readonly fetch: typeof globalThis.fetch;
  },
): Promise<PreparedBuild> {
  const { ws, project } = session;
  const build = project.config.build;
  if (!build)
    throw new ConfigError("BUILD_NOT_CONFIGURED", "`build` is not configured in .qa/qa.project.yaml.", {});
  // REQ-CTX-04/AC4: only the worktree fetched for this run is built, so the tested code is the analysed code.
  if (ws.record.repos[build.repo] === undefined)
    throw new ConfigError(
      "BUILD_REPO_NOT_FETCHED",
      `Repository '${build.repo}' was not fetched for this run; run 'qajitsu fetch' with its change first.`,
      { repo: build.repo },
    );
  const worktree = ws.path("repos", build.repo);
  const problems = await checkBuildConfig({
    config: project.config,
    qaDir: project.qaDir,
    worktree,
    secretExists: (ref) =>
      session.resolveSecret(ref).then(
        () => true,
        () => false,
      ),
  });
  for (const [service, vars] of Object.entries(options.overrides)) {
    const declared = project.config.services[service];
    if (!declared) problems.push({ where: `--set ${service}`, problem: "unknown service" });
    for (const name of Object.keys(vars)) {
      const spec = declared?.env[name];
      if (declared && !(typeof spec === "object" && "overridable" in spec && spec.overridable))
        problems.push({ where: `--set ${service}.${name}`, problem: "variable is not overridable" });
    }
  }
  if (problems.length > 0)
    throw new ConfigError(
      "ENV_CONFIG_INVALID",
      `The --build configuration is invalid:\n${problems.map((p) => `  ✘ ${p.where}: ${p.problem}`).join("\n")}`,
      { problems },
    );
  try {
    return {
      build: await createComposeEnvProvider({
        ticket: ws.ticket,
        runId: ws.runId,
        config: project.config,
        qaDir: project.qaDir,
        worktree,
        envDir: ws.path("env"),
        logsDir: ws.path("logs"),
        resolveSecret: (ref) => session.resolveSecret(ref),
        mask: (text) => session.masker.maskText(text),
        overrides: options.overrides,
        fetch: options.fetch,
        ...(options.exec ? { exec: options.exec } : {}),
      }).start(),
    };
  } catch (error) {
    if (!(error instanceof BuildStartError)) throw error;
    const logs = Array.isArray(error.context["logs"]) ? (error.context["logs"] as string[]) : [];
    return { failure: { message: error.message, logs } };
  }
}

/**
 * Records every case BLOCKED after a start failure, with the masked service logs as evidence in the
 * manifest (REQ-ENV-04/AC3, invariants 2 and 7). No agent decides anything here.
 */
export async function blockAfterStartFailure(
  session: RunSession,
  caseIds: readonly string[],
  failure: NonNullable<PreparedBuild["failure"]>,
  results: Map<string, CaseResultFile>,
): Promise<void> {
  const store = createLocalEvidenceStore(session.ws.path("evidence"));
  const logs = await Promise.all(
    failure.logs.map(async (file) => ({
      name: basename(file),
      content: session.masker.maskText(await readFile(file, "utf8").catch(() => "")),
    })),
  );
  for (const caseId of caseIds) {
    const evidence: string[] = [];
    for (const log of logs) {
      const stored = await store.put(
        { path: `${caseId}/attempt-1/${log.name}`, caseId, kind: "log" },
        new TextEncoder().encode(log.content),
      );
      evidence.push(stored.path);
    }
    const result = CaseResultFileSchema.parse({
      schema: 1,
      caseId,
      runner: "api",
      attempts: [
        {
          attempt: 1,
          outcome: "error",
          assertions: [],
          error: `environment did not start: ${session.masker.maskText(failure.message)}`,
          steps: [],
          evidence,
        },
      ],
    });
    await writeFile(session.ws.path("results", `${caseId}.json`), `${JSON.stringify(result, null, 2)}\n`, {
      flag: "wx",
    });
    results.set(caseId, result);
  }
}

/** Removes generated `.env` files; called on every exit path, also with `--keep` (REQ-CFG-05/AC2). */
export async function removeEnvFiles(session: RunSession): Promise<void> {
  for (const f of await readdir(session.ws.path("env")).catch(() => []))
    if (f.endsWith(".env")) await rm(session.ws.path("env", f), { force: true });
}

/**
 * Applies the cleanup policy after a run (REQ-WS-03/AC1, AC3): `always` cleans, `never` keeps,
 * `on_success` cleans only when every case passed; `--keep` keeps for this run. Kept containers are
 * removed later by `qajitsu clean` or `qajitsu gc`.
 *
 * @returns Whether the runtime resources were kept.
 */
export async function finishRunResources(
  session: RunSession,
  build: BuildEnvironment | undefined,
  options: { readonly keep: boolean; readonly allPassed: boolean },
): Promise<{ kept: boolean; logs: readonly string[] }> {
  const policy = session.project.config.cleanup.policy;
  const kept = options.keep || policy === "never" || (policy === "on_success" && !options.allPassed);
  const { logs } = build ? await build.stop({ keep: kept }) : { logs: [] };
  if (!kept) await cleanRunFiles(session.ws);
  await removeEnvFiles(session);
  return { kept, logs };
}

/**
 * The effective configuration of the run with secrets masked (REQ-CFG-01/AC2): project profile,
 * environment profile and run overrides. Secrets appear only as `secret://` references or masked.
 */
export function effectiveConfig(
  session: RunSession,
  env: ResolvedEnvironment,
  overrides: Readonly<Record<string, Record<string, string>>>,
): unknown {
  return session.masker.maskJson({
    project: session.project.config,
    environment: { name: env.name, ...env.profile },
    overrides,
  });
}
