import type { KnowledgePorts } from "./knowledge.js";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compareDeployedSha, createRemoteEnvProvider, loginAccounts } from "@qajitsu/adapter-env-remote";
import { createLocalEvidenceStore } from "@qajitsu/adapter-evidence-local";
import {
  createSandboxExecutor,
  type BrowserFactory,
  loadContractValidator,
  runCases,
  type AttemptExecutor,
  type ContractValidator,
} from "@qajitsu/adapter-runner-api";
import { createPlaywrightBrowserFactory } from "@qajitsu/adapter-runner-web";
import { buildChangeContext, checkSpec, createUsageTracker, healSpec, runAuthor } from "@qajitsu/agents";
import {
  AnalysisSchema,
  ConfigError,
  CaseResultFileSchema,
  acquireRunLock,
  QajitsuError,
  exitCodeFor,
  loadApprovedPlan,
  resolveEnvironment,
  selectExecutableSpecs,
  type CaseResultFile,
  type Plan,
  type ResolvedEnvironment,
} from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import { formatSpecProblems } from "@qajitsu/verifier";
import { buildAdapters, type RuntimePorts } from "../adapters.js";
import { codeIndexCache, openSession, type ModelPorts, type RunSession } from "../session.js";
import type { CommandIO } from "./fetch.js";
import { anchorJournal, computeVerdict, writeReports } from "./verdict.js";
import { auditRun, runCanary } from "./checks.js";
import { approvalContext, changedParts, type ApprovalContext } from "./context-fingerprint.js";
import { runRunHook, type HookExec } from "./hooks.js";
import { prepareMobile, type PreparedMobile } from "./mobile.js";
import { exportRunTelemetry } from "./telemetry.js";
import {
  blockAfterStartFailure,
  effectiveConfig,
  finishRunResources,
  parseOverrides,
  prepareBuild,
  removeEnvFiles,
  type PreparedBuild,
} from "./build-env.js";
import type { CommandExec } from "@qajitsu/adapter-env-compose";

/** Options of `qajitsu run`. */
export interface RunOptions {
  readonly run?: string | undefined;
  readonly env?: string | undefined;
  /** Build the application from the fetched worktrees instead of testing a provided environment. */
  readonly build?: boolean | undefined;
  /** Keep containers and worktrees after this run, whatever the cleanup policy (REQ-WS-03/AC1). */
  readonly keep?: boolean | undefined;
  /** Run overrides `<service>.<VAR>=<value>` (REQ-CFG-02/AC3). */
  readonly set?: readonly string[] | undefined;
}

/** Ports `run` needs beyond the common ones; the executor is replaceable in tests. */
export interface RunPorts extends KnowledgePorts {
  readonly executor?: AttemptExecutor;
  /** Executor of mobile cases for a device factory (replaced in tests with a fake device). */
  readonly mobileExecutor?: (device: BrowserFactory) => AttemptExecutor;
  /** Device for mobile cases (replaced in tests); default: emulator/farm from the mobile config. */
  readonly mobileDevice?: () => Promise<PreparedMobile>;
  /** Runs docker and other commands of `--build` (replaced in tests). */
  readonly buildExec?: CommandExec;
  /** Source of SIGINT/SIGTERM and the exit function (default: the process; replaced in tests). */
  readonly signals?: {
    on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
    off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  };
  readonly exit?: (code: number) => void;
  /** Runs setup and teardown hooks (replaced in tests). */
  readonly hookExec?: HookExec;
}

const RUNNER = { kind: "runner", name: "api" } as const;
const SYSTEM = { kind: "system", name: "orchestrator" } as const;

const blockedResult = (caseId: string, reason: string): CaseResultFile =>
  CaseResultFileSchema.parse({
    schema: 1,
    caseId,
    runner: "api",
    attempts: [{ attempt: 1, outcome: "error", assertions: [], error: reason, steps: [], evidence: [] }],
  });

async function writeBlocked(
  session: RunSession,
  caseIds: readonly string[],
  reason: string,
  results: Map<string, CaseResultFile>,
): Promise<void> {
  for (const id of caseIds) {
    const result = blockedResult(id, reason);
    await writeFile(session.ws.path("results", `${id}.json`), `${JSON.stringify(result, null, 2)}\n`, {
      flag: "wx",
    });
    results.set(id, result);
  }
}

/**
 * The environment of a command: `--env`, else `environments.default`; interactive sessions are asked when neither
 * is set (REQ-ENV-07).
 *
 * @throws {ConfigError} `ENV_NOT_SELECTED` and the allowlist and production errors of `resolveEnvironment`.
 */
export async function chooseEnvironment(
  session: RunSession,
  io: CommandIO,
  env: string | undefined,
): Promise<ResolvedEnvironment> {
  try {
    return await resolveEnvironment({ config: session.project.config, qaDir: session.project.qaDir, env });
  } catch (error) {
    // REQ-ENV-07/AC2: without a default, interactive runs ask; CI fails with the configuration error.
    if (error instanceof ConfigError && error.code === "ENV_NOT_SELECTED" && io.ask) {
      const answer = (await io.ask("Environment profile or URL: ")).trim();
      if (answer !== "")
        return resolveEnvironment({
          config: session.project.config,
          qaDir: session.project.qaDir,
          env: answer,
        });
    }
    throw error;
  }
}

/**
 * `qajitsu run <TICKET> [--env <profile|url>]`: executes the approved plan against a provided
 * environment and writes results, evidence and reports (roadmap stage 3).
 *
 * @returns Exit code from statuses (0 all passed, 1 any failed, 2 otherwise) or 3 on errors (REQ-CI-04).
 */
export async function runRun(
  rawKey: string,
  options: RunOptions,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts & RunPorts,
): Promise<number> {
  const masker = createMasker();
  let release: (() => Promise<void>) | undefined;
  let stopOnInterrupt: (() => Promise<void>) | undefined;
  // REQ-CFG-05/AC2: an interrupt still stops the environment and deletes the generated .env files.
  // Listening with `on`: a second Ctrl+C during a long `docker compose up` must not skip the cleanup.
  let interrupted = false;
  const deviceStops: (() => Promise<void>)[] = [];
  const onSignal = (): void => {
    if (interrupted) return;
    interrupted = true;
    // Devices first (emulator, Appium), then the built environment and its .env files.
    const devices = Promise.all(deviceStops.map((s) => s().catch(() => undefined)));
    void devices
      .then(() => stopOnInterrupt?.() ?? Promise.resolve())
      .finally(() => {
        void (release?.() ?? Promise.resolve()).finally(() => {
          (ports.exit ?? ((code: number) => process.exit(code)))(130);
        });
      });
  };
  const signals = ports.signals ?? process;
  signals.on("SIGINT", onSignal);
  signals.on("SIGTERM", onSignal);
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const { ws, events, project } = session;
    if (ws.record.data["results"] !== undefined) {
      throw new ConfigError(
        "RUN_ALREADY_EXECUTED",
        "This run already has results; start a new run to test again.",
        {},
      );
    }
    if (!options.build && (options.keep || (options.set ?? []).length > 0))
      throw new ConfigError("BUILD_OPTION_WITHOUT_BUILD", "--keep and --set apply to --build runs only.", {});
    if (options.build && options.env !== undefined && /^https?:\/\//.test(options.env))
      throw new ConfigError(
        "BUILD_WITH_URL",
        "--build starts its own environment; --env takes a profile name.",
        {},
      );
    const overrides = parseOverrides(options.set ?? []);
    // REQ-WS-04/AC2: one process per run; other runs of the ticket may run in parallel.
    release = await acquireRunLock(ws.path("run.lock"));
    const { plan, approval } = await loadApprovedPlan(ws);
    // REQ-PRJ-06/AC3: a run never continues silently after its environment or secrets changed since approval.
    const approvedContext = ws.record.data["approvalContext"] as ApprovalContext | undefined;
    if (approvedContext) {
      const changed = changedParts(approvedContext, await approvalContext(session));
      if (changed.length > 0) {
        const what = changed.join(" and ");
        const answer = io.ask
          ? (
              await io.ask(
                `The ${what} changed since the plan was approved. Run with the changed ${what}? [y/N] `,
              )
            )
              .trim()
              .toLowerCase()
          : "";
        if (answer !== "y" && answer !== "yes")
          throw new ConfigError(
            "RUN_CONTEXT_CHANGED",
            `The ${what} changed since the plan was approved; confirm interactively or start a new run with 'qajitsu fetch ${ws.ticket}'.`,
            { changed },
          );
        events.emit("run", { kind: "user", name: "cli" }, "approval.context_reconfirmed", { changed });
        await ws.update({ data: { ...ws.record.data, approvalContext: await approvalContext(session) } });
      }
    }
    events.emit("run", SYSTEM, "stage.start", { planVersion: approval.version });
    const results = new Map<string, CaseResultFile>();

    let prepared: PreparedBuild = {};
    if (options.build) {
      io.write(`Building the environment from ${project.config.build?.repo ?? "?"}…\n`);
      const started = prepareBuild(session, { overrides, exec: ports.buildExec, fetch: ports.fetch });
      stopOnInterrupt = async () => {
        const pending: PreparedBuild = await started.catch(() => ({}));
        await pending.build?.stop();
        await removeEnvFiles(session);
      };
      prepared = await started;
      events.emit("run", SYSTEM, "env.build", {
        ok: prepared.failure === undefined,
        ...(prepared.build ? { project: prepared.build.project, stubs: prepared.build.stubs } : {}),
        ...(prepared.failure ? { error: masker.maskText(prepared.failure.message) } : {}),
      });
      stopOnInterrupt = async () => {
        await prepared.build?.stop();
        await removeEnvFiles(session);
      };
    }
    const built = prepared.build;
    const env = options.build
      ? await resolveEnvironment({
          config: project.config,
          qaDir: project.qaDir,
          env: options.env,
          buildBaseUrl: built?.baseUrl ?? "http://127.0.0.1:9",
        })
      : await chooseEnvironment(session, io, options.env);
    // REQ-ENV-01/AC1, REQ-ENV-02: health and deployed version through the EnvProvider seam (ADR-0005); a built
    // environment is checked on the profile's health path too, its version is the worktree's.
    const reached = prepared.failure
      ? undefined
      : await createRemoteEnvProvider(env, ports.fetch, { readVersion: !built }).start();
    const health = reached?.health ?? { ok: false, detail: prepared.failure?.message ?? "not started" };
    events.emit("run", SYSTEM, "env.health", { env: env.name, ok: health.ok, detail: health.detail });
    const deployedSha = reached?.deployedSha;
    // The tests repository is not deployed; only the analysed change counts (REQ-CTX-06).
    const analysed = Object.values(ws.record.repos)
      .filter((r) => r.role !== "tests")
      .map((r) => r.sha);
    // A built environment runs exactly the fetched worktree (REQ-CTX-04/AC4).
    const versionCheck = built ? "built-from-worktree" : compareDeployedSha(deployedSha, analysed);
    await ws.update({
      status: "running",
      stage: "run",
      data: {
        ...ws.record.data,
        environment: {
          name: env.name,
          baseUrl: env.baseUrl,
          deployedSha,
          versionCheck,
          ...(built ? { stubs: built.stubs } : {}),
        },
        // REQ-CFG-01/AC2: the effective configuration, secrets masked.
        config: effectiveConfig(session, env, overrides),
        ...(built ? { build: { project: built.project, ports: built.ports, services: built.services } } : {}),
      },
    });

    let teardownDue = false;
    if (prepared.failure) {
      // REQ-ENV-04/AC3: the application did not start; every case is BLOCKED with the service logs.
      io.writeError(
        `The environment did not start (${masker.maskText(prepared.failure.message)}); every case is BLOCKED.\n`,
      );
      await blockAfterStartFailure(
        session,
        plan.cases.map((c) => c.id),
        prepared.failure,
        results,
      );
    } else if (!health.ok) {
      // REQ-ENV-01/AC1: an unreachable environment makes every case BLOCKED.
      io.writeError(`Environment ${env.name} is not healthy (${health.detail}); every case is BLOCKED.\n`);
      await writeBlocked(
        session,
        plan.cases.map((c) => c.id),
        `environment not healthy: ${health.detail}`,
        results,
      );
    } else {
      if (versionCheck === "mismatch") {
        const message = `Environment runs ${String(deployedSha)}, the change is ${analysed.map((s) => s.slice(0, 12)).join(", ")}.`;
        events.emit("run", SYSTEM, "env.version_mismatch", { deployedSha, analysed });
        if (io.ask) {
          const answer = (await io.ask(`${message} Test anyway? [y/N] `)).trim().toLowerCase();
          events.emit("run", { kind: "user", name: "cli" }, "env.version_confirmed", { answer });
          if (answer !== "y" && answer !== "yes")
            throw new ConfigError("ENV_VERSION_MISMATCH", `${message} Aborted.`, {});
        } else if (project.config.environments.on_version_mismatch === "fail") {
          throw new ConfigError("ENV_VERSION_MISMATCH", message, { deployedSha });
        } else {
          io.writeError(`Warning: ${message}\n`);
        }
      }
      // REQ-GEN-01/AC2: the project's setup hook prepares data; if it fails nothing can be tested.
      const setup = await runRunHook(session, "setup", env, ports.hookExec);
      if (!setup.ok) {
        io.writeError(
          `Setup hook ${setup.script ?? ""} failed; every case is BLOCKED. Log: ${setup.log ?? ""}\n`,
        );
        await blockAfterStartFailure(
          session,
          plan.cases.map((c) => c.id),
          { message: `setup hook ${setup.script ?? ""} failed`, logs: setup.log ? [setup.log] : [] },
          results,
        );
      } else {
        const pending = await executeCases(session, plan, env, io, ports, results, {
          build: options.build === true,
          onDevice: (stop) => deviceStops.push(stop),
        });
        if (pending.length > 0)
          io.write(`Rejected spec files (not in the approved plan or misplaced): ${pending.join(", ")}\n`);
        // REQ-VER-06: the independent auditor reviews what PASSED; it can only downgrade.
        const audit = await auditRun(session, ports.now);
        if (audit?.status === "failed")
          io.writeError(`Auditor did not complete (${audit.mode}): ${audit.error}\n`);
      }
      teardownDue = true;
    }

    // Statuses, gates and reports: computed by code only, from the files on disk (invariants 1, 6, 7).
    const verdict = await computeVerdict(session, ports.now);
    await writeReports(session, verdict);
    // Teardown runs after the verdict and the reports exist, so it cannot influence them; a failure is a warning.
    if (teardownDue) {
      const teardown = await runRunHook(session, "teardown", env, ports.hookExec);
      if (!teardown.ok)
        io.writeError(`Warning: teardown hook ${teardown.script ?? ""} failed. Log: ${teardown.log ?? ""}\n`);
    }
    const statuses = Object.fromEntries(verdict.cases.map((c) => [c.caseId, c.status]));
    // REQ-WS-03: cleanup policy; service logs land in logs/ before containers go.
    stopOnInterrupt = undefined;
    const cleanup = await finishRunResources(session, built, {
      keep: options.keep === true,
      allPassed: verdict.cases.every((c) => c.status === "PASSED"),
    });
    if (built) {
      events.emit("run", SYSTEM, "env.cleanup", { kept: cleanup.kept, logs: cleanup.logs.length });
      if (cleanup.kept)
        io.write(
          `Environment kept (${built.project}); remove it with: qajitsu clean ${ws.ticket} --run ${ws.runId}\n`,
        );
    }
    await ws.update({
      status: "completed",
      stage: "run",
      data: { ...ws.record.data, results: statuses, gatesOk: verdict.ok },
      checkpoints: [...ws.record.checkpoints, { stage: "run", at: ports.now().toISOString() }],
    });
    events.emit("run", SYSTEM, "stage.end", { statuses, gatesOk: verdict.ok });
    // REQ-OBS-03: export what this command added to the journal; telemetry never changes the result.
    await anchorJournal(session);
    const telemetry = await exportRunTelemetry(session, ports.fetch);
    if (telemetry?.error !== undefined) io.writeError(`Telemetry export failed: ${telemetry.error}\n`);
    io.write(`${verdict.matrixMd}\n`);
    io.write(`Report: ${ws.path("report", "report.html")}\n`);
    if (!verdict.ok) {
      io.writeError(
        `Publish gates failed; results must not be published:\n${verdict.failed.map((g) => `  ✘ ${g.gate}: ${g.problems.join("; ")}`).join("\n")}\n`,
      );
    }
    const code = exitCodeFor(verdict.cases.map((c) => c.status));
    return !verdict.ok && code === 0 ? 2 : code;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    const issues =
      error instanceof QajitsuError && Array.isArray(error.context["issues"])
        ? (error.context["issues"] as unknown[]).map((i) => `  - ${String(i)}\n`).join("")
        : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n${issues}`),
    );
    await stopOnInterrupt?.().catch(() => undefined);
    return 3;
  } finally {
    signals.off("SIGINT", onSignal);
    signals.off("SIGTERM", onSignal);
    await release?.();
  }
}

/**
 * Authors missing specs, checks every spec, executes the approved ones and fills `results`.
 *
 * @returns Spec files that were rejected (not in the plan or misplaced).
 */
async function executeCases(
  session: RunSession,
  plan: Plan,
  env: ResolvedEnvironment,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts & RunPorts,
  results: Map<string, CaseResultFile>,
  run: { readonly build: boolean; readonly onDevice: (stop: () => Promise<void>) => void } = {
    build: false,
    onDevice: () => undefined,
  },
): Promise<string[]> {
  const { ws, events, project, masker } = session;
  const specsDir = ws.path("specs");
  const existing = new Set(
    (await readdir(specsDir))
      .map((f) => /^(TC-\d{2,4})\.spec\.ts$/.exec(f)?.[1])
      .filter((x): x is string => x !== undefined),
  );
  const missing = plan.cases.filter((c) => !existing.has(c.id));
  const blocked = new Map<string, string>();
  if (missing.length > 0) {
    io.write(`Writing specs for ${missing.map((c) => c.id).join(", ")}…\n`);
    const analysis = AnalysisSchema.parse(JSON.parse(await readFile(ws.path("analysis.json"), "utf8")));
    const usage = createUsageTracker({
      events,
      budget: project.config.models.token_budget,
      alreadyUsed: Number(ws.record.data["tokens"] ?? 0),
    });
    const deps = {
      ws,
      models: session.models,
      events,
      usage,
      now: ports.now,
      maskJson: (v: unknown) => masker.maskJson(v),
      maskText: (t: string) => masker.maskText(t),
      // REQ-EXEC-01/AC2: exploration through MCP stays inside the environment allowlist (invariant 10).
      mcp: { servers: project.config.mcp.servers, allowedOrigins: [env.origin] },
    };
    const authored = await runAuthor(
      deps,
      { ...plan, cases: missing },
      await buildChangeContext(ws, [], { indexCache: codeIndexCache(project) }),
      analysis,
      Object.keys(env.profile.accounts),
    );
    await ws.update({ data: { ...ws.record.data, tokens: usage.total } });
    for (const a of authored)
      if (!a.file)
        blocked.set(a.caseId, `author could not produce a valid spec: ${formatSpecProblems(a.problems)}`);
  }
  // Every spec is checked before execution, also hand-written ones (REQ-EXEC-03).
  const files = (await readdir(specsDir)).map((f) => join(specsDir, f));
  const { execute, rejected } = selectExecutableSpecs(plan, files, specsDir);
  for (const file of rejected)
    events.emit("run", SYSTEM, "spec.rejected", { file: file.slice(ws.dir.length + 1) });
  const specs = new Map<string, string>();
  for (const file of execute) {
    const caseId = /(TC-\d{2,4})\.spec\.ts$/.exec(file)?.[1] ?? "";
    const problems = await checkSpec(await readFile(file, "utf8"), caseId, plan);
    if (problems.length > 0)
      blocked.set(caseId, `spec failed static checks: ${formatSpecProblems(problems)}`);
    else specs.set(caseId, file);
  }
  for (const [caseId, reason] of blocked) {
    events.emit("run", SYSTEM, "case.blocked", { caseId, reason: reason.slice(0, 500) });
    await writeBlocked(session, [caseId], reason, results);
  }
  const executor =
    ports.executor ??
    createSandboxExecutor({
      // The browser starts only when a spec uses ui.* (REQ-EXEC-05, REQ-EXEC-07).
      browser: createPlaywrightBrowserFactory({
        browser: project.config.web.browser,
        video: project.config.web.video,
        headless: project.config.web.headless,
        actionTimeoutMs: project.config.web.action_timeout_ms,
        webSession: env.profile.web_session,
        // REQ-EVD-07/AC5: each passive check can be switched off.
        observations: {
          console: project.config.observations.console,
          httpErrors: project.config.observations.http_errors,
          accessibility: project.config.observations.accessibility,
        },
      }),
    });
  // The contract is read from the worktree, i.e. from exactly the analysed version of the code.
  let contract: ContractValidator | undefined;
  for (const [alias, repo] of Object.entries(project.config.repos)) {
    if (repo.openapi === undefined || ws.record.repos[alias] === undefined) continue;
    contract = await loadContractValidator(ws.path("repos", alias, repo.openapi));
    events.emit("run", SYSTEM, "contract.loaded", { repo: alias, file: repo.openapi });
    break;
  }
  const base = {
    executor,
    baseUrl: env.baseUrl,
    allowedOrigins: [env.origin],
    login: () =>
      loginAccounts(env, {
        fetch: ports.fetch,
        qaDir: project.qaDir,
        resolveSecret: (r) => session.resolveSecret(r),
        registerSecret: (v) => {
          masker.register(v);
        },
      }),
    contract,
    events,
    now: ports.now,
  };
  const evidence = createLocalEvidenceStore(ws.path("evidence"));
  const ran = await runCases({
    ...base,
    plan: { ...plan, cases: plan.cases.filter((c) => !blocked.has(c.id) && c.type !== "mobile") },
    specs,
    evidence,
    resultsDir: ws.path("results"),
    retries: project.config.environments.retries,
    workers: project.config.environments.workers,
    // REQ-EXEC-09: web cases that could not run get at most two healed attempts.
    heal: async (caseId, specFile, failed, healAttempt) => {
      if (plan.cases.find((c) => c.id === caseId)?.type !== "web") return undefined;
      const usage = createUsageTracker({
        events,
        budget: project.config.models.token_budget,
        alreadyUsed: Number(ws.record.data["tokens"] ?? 0),
      });
      const dom = failed.evidence.find((e) => e.kind === "dom")?.content;
      const { file } = await healSpec(
        {
          ws,
          models: session.models,
          events,
          usage,
          now: ports.now,
          maskJson: (v: unknown) => masker.maskJson(v),
          maskText: (t: string) => masker.maskText(t),
        },
        plan,
        {
          caseId,
          specFile,
          error: masker.maskText(failed.error ?? "unknown error"),
          dom: typeof dom === "string" ? dom : undefined,
          attempt: healAttempt,
        },
      ).catch((error: unknown) => {
        events.emit("heal", { kind: "agent", name: "healer" }, "heal.error", {
          caseId,
          error: error instanceof Error ? error.message : String(error),
        });
        return { file: undefined };
      });
      return file;
    },
  });
  // REQ-VER-09: the canary re-runs one PASSED case with an inverted expectation; it must fail.
  if (project.config.verification.canary) await runCanary(session, plan, ran, specs, base);
  for (const [id, r] of ran) results.set(id, r);
  // REQ-EXEC-06/AC3, REQ-EXEC-10/AC2: mobile cases run after the others, one at a time per device.
  const mobileCases = plan.cases.filter((c) => c.type === "mobile" && !blocked.has(c.id) && specs.has(c.id));
  if (mobileCases.length > 0) {
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
    events.emit("run", SYSTEM, "mobile.prepare", { cases: mobileCases.map((c) => c.id) });
    const device = await (ports.mobileDevice?.() ??
      prepareMobile(session, env.baseUrl, codeHosts, ports.env["APPIUM_HOME"], { allowBuild: run.build }));
    if (!device.ok) {
      // REQ-ENV-06/AC3: a platform that is not available here is reported, never silently skipped.
      io.writeError(`Mobile cases are BLOCKED: ${device.reason}\n`);
      await writeBlocked(
        session,
        mobileCases.map((c) => c.id),
        `mobile device not available: ${device.reason}`,
        results,
      );
    } else {
      // Ctrl+C during mobile cases still stops the emulator and the Appium server.
      run.onDevice(device.stop);
      try {
        // REQ-EXEC-10/AC2: cases split round-robin among the devices; one case at a time per device.
        const groups = device.factories.map((factory, d) => ({
          factory,
          cases: mobileCases.filter((_, i) => i % device.factories.length === d),
        }));
        const perDevice = await Promise.all(
          groups
            .filter((g) => g.cases.length > 0)
            .map((g) =>
              runCases({
                ...base,
                executor: ports.mobileExecutor?.(g.factory) ?? createSandboxExecutor({ browser: g.factory }),
                plan: { ...plan, cases: g.cases },
                specs: new Map([...specs].filter(([id]) => g.cases.some((c) => c.id === id))),
                evidence,
                resultsDir: ws.path("results"),
                retries: project.config.environments.retries,
                workers: 1,
              }),
            ),
        );
        for (const mobileRan of perDevice)
          for (const [id, r] of mobileRan) {
            results.set(id, r);
            ran.set(id, r);
          }
      } finally {
        await device.stop();
      }
    }
  }
  events.emit("run", RUNNER, "cases.done", { cases: ran.size });
  return rejected.map((f) => f.slice(ws.dir.length + 1));
}
