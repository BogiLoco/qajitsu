import type { KnowledgePorts } from "./knowledge.js";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareDeployedSha, createRemoteEnvProvider } from "@qajitsu/adapter-env-remote";
import { createLocalEvidenceStore } from "@qajitsu/adapter-evidence-local";
import {
  createSandboxExecutor,
  type BrowserFactory,
  loadContractValidator,
  runCases,
  type AttemptExecutor,
  type ContractValidator,
  type RunCasesOptions,
} from "@qajitsu/adapter-runner-api";
import {
  browserUnavailable,
  compareImages,
  createPlaywrightBrowserFactory,
} from "@qajitsu/adapter-runner-web";
import { buildChangeContext, checkSpec, createUsageTracker, healSpec, runAuthor } from "@qajitsu/agents";
import {
  AnalysisSchema,
  ConfigError,
  CaseResultFileSchema,
  acquireRunLock,
  createAccountLeases,
  laneWorkers,
  QajitsuError,
  exitCodeFor,
  loadApprovedPlan,
  resolveEnvironment,
  selectExecutableSpecs,
  planForLocale,
  webCombinations,
  type CaseResultFile,
  type Plan,
  type UiElementFact,
  type UiScreen,
  type ResolvedEnvironment,
  type VisualCheck,
  type WebCombination,
} from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import { formatSpecProblems } from "@qajitsu/verifier";
import { buildAdapters, type RuntimePorts } from "../adapters.js";
import { codeIndexCache, openSession, type ModelPorts, type RunSession } from "../session.js";
import type { CommandIO } from "./fetch.js";
import { anchorJournal, computeVerdict, writeReports } from "./verdict.js";
import { auditRun, triageRun, runCanary } from "./checks.js";
import { createManualPrompter } from "./manual.js";
import { formatEstimate, readRunHistory } from "./estimate.js";
import { rootOf } from "./runs.js";
import { runMessages, type MessagePorts, type RunMessages } from "./messages.js";
import { approvalContext, changedParts, type ApprovalContext } from "./context-fingerprint.js";
import { runRunHook, type HookExec } from "./hooks.js";
import { prepareMobile, type PreparedMobile } from "./mobile.js";
import { accountLogin, runLimited, runMobileLane } from "./lanes.js";
import { recordUiSnapshot } from "./ui-snapshot.js";
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
import { headlessFor, prepareLiveRun, type LiveOptions, type LiveRun } from "./live.js";
import { RegressionRunSchema } from "./pack.js";
import { runVersions } from "../versions.js";
import { createProgressPrinter, liveScreenshots, teeEvents } from "./progress.js";

/** Options of `qajitsu run`. */
export interface RunOptions extends LiveOptions {
  readonly run?: string | undefined;
  readonly env?: string | undefined;
  /** Build the application from the fetched worktrees instead of testing a provided environment. */
  readonly build?: boolean | undefined;
  /** Keep containers and worktrees after this run, whatever the cleanup policy (REQ-WS-03/AC1). */
  readonly keep?: boolean | undefined;
  /** Run overrides `<service>.<VAR>=<value>` (REQ-CFG-02/AC3). */
  readonly set?: readonly string[] | undefined;
  /** The person running the command; recorded with manual step answers given in this terminal (REQ-EXEC-11). */
  readonly user?: string | undefined;
  /** One case at a time, in plan order, across every lane and device (REQ-EXEC-19/AC2). */
  readonly sequential?: boolean | undefined;
}

/** Ports `run` needs beyond the common ones; the executor is replaceable in tests. */
export interface RunPorts extends KnowledgePorts, MessagePorts {
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
  /** Why a browser of the matrix cannot run (replaced in tests); default: its Playwright build is missing. */
  readonly browserUnavailable?: (browser: "chromium" | "firefox" | "webkit") => string | undefined;
  /** Runs setup and teardown hooks (replaced in tests). */
  readonly hookExec?: HookExec;
  /** Operating system, for the display check of `--headed` (default: the process's). */
  readonly platform?: string;
  /** Browser for the snapshot before the author (replaced in tests); default: headless Playwright (REQ-EXEC-22). */
  readonly snapshotBrowser?: BrowserFactory;
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

/**
 * Records the pages and screens the author will see (REQ-EXEC-22): web pages through a headless browser with the
 * run's logins and allowlist, the first screen of the app on the run's device. Tests without a real browser pass
 * `snapshotBrowser`; a fake executor without one records no web pages.
 */
async function snapshotForAuthor(
  session: RunSession,
  plan: Plan,
  cases: Plan["cases"],
  env: ResolvedEnvironment,
  ports: RuntimePorts & ModelPorts & RunPorts,
  options: {
    readonly knownPages: readonly string[];
    readonly device: (() => Promise<PreparedMobile>) | undefined;
    readonly platform: "android" | "ios";
    readonly io: CommandIO;
  },
): Promise<UiScreen[]> {
  const { project, masker, events } = session;
  const webFactory =
    ports.snapshotBrowser ??
    (ports.executor
      ? undefined
      : createPlaywrightBrowserFactory({
          browser: project.config.web.browser,
          video: "off",
          headless: true,
          actionTimeoutMs: project.config.web.action_timeout_ms,
          webSession: env.profile.web_session,
          observations: { console: false, httpErrors: false, accessibility: false },
        }));
  const login = accountLogin(
    env,
    createAccountLeases(env.profile, { waitMs: project.config.execution.account_wait_s * 1000 }),
    {
      fetch: ports.fetch,
      qaDir: project.qaDir,
      resolveSecret: (r) => session.resolveSecret(r),
      registerSecret: (v) => {
        masker.register(v);
      },
    },
  );
  const device = cases.some((c) => c.type === "mobile") ? await options.device?.() : undefined;
  const scratch = await mkdtemp(join(tmpdir(), "qj-snapshot-"));
  try {
    const screens = await recordUiSnapshot({
      plan,
      cases,
      ...(webFactory && cases.some((c) => c.type === "web")
        ? {
            web: {
              factory: webFactory,
              // The login finds the aliases it needs in a file, as for a spec.
              login: async (aliases) => {
                const file = join(scratch, `${aliases.join("-").replace(/[^\w-]/g, "_")}.txt`);
                await writeFile(file, aliases.join("\n"), "utf8");
                return login({ caseId: "snapshot", attempt: 0, specFile: file, lane: "web" });
              },
              aliases: Object.keys(env.profile.accounts),
              knownPages: options.knownPages,
              baseUrl: env.baseUrl,
              allowedOrigins: [env.origin],
            },
          }
        : {}),
      ...(device?.ok && device.factories[0]
        ? {
            mobile: {
              factory: device.factories[0],
              platform: options.platform,
            },
          }
        : {}),
      mask: (v) => masker.maskJson(v),
      emit: (event, details) => {
        events.emit("author", SYSTEM, event, details);
        // REQ-EXEC-22/AC6: the person sees what could not be recorded; the author goes on without it.
        if (event === "ui.snapshot.failed")
          options.io.writeError(
            `Could not record ${String(details["where"])} for the author: ${String(details["error"])}\n`,
          );
      },
    });
    if (screens.length > 0)
      options.io.write(
        `Recorded ${String(screens.length)} page(s) or screen(s) of the application for the author.\n`,
      );
    return screens;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The devices of the run's mobile cases, started on the first call and shared by later ones (REQ-EXEC-06,
 * REQ-EXEC-22): the snapshot before the author and the mobile lane use the same emulators.
 */
function mobileDevices(
  session: RunSession,
  env: ResolvedEnvironment,
  ports: RuntimePorts & ModelPorts & RunPorts,
  options: { readonly build: boolean; readonly headed: boolean; readonly cases: readonly string[] },
): { readonly get: () => Promise<PreparedMobile>; readonly started: () => boolean } {
  let device: Promise<PreparedMobile> | undefined;
  return {
    get: () => {
      if (device) return device;
      const { codeHosts } = buildAdapters(
        session.project,
        {
          fetch: ports.fetch,
          logger: session.logger,
          now: ports.now,
          resolveSecret: (r) => session.resolveSecret(r),
          registerSecret: (v) => {
            session.masker.register(v);
          },
        },
        ports,
      );
      session.events.emit("run", SYSTEM, "mobile.prepare", { cases: options.cases });
      device =
        ports.mobileDevice?.() ??
        prepareMobile(session, env.baseUrl, codeHosts, ports.env["APPIUM_HOME"], {
          allowBuild: options.build,
          // REQ-EXEC-16/AC2: --headed shows the emulator window.
          headed: options.headed,
        });
      return device;
    },
    started: () => device !== undefined,
  };
}

/**
 * Runs the web cases again in every further browser and viewport combination (REQ-EXEC-13/AC1): results go to
 * `results/matrix/<combo>/`, evidence under `matrix/<combo>/`. A browser that is not installed makes its
 * combinations BLOCKED with the reason (AC3). Cases with manual steps run in the primary combination only, so
 * nobody is asked once per browser; healing stays with the primary run.
 */
async function runMatrix(
  session: RunSession,
  plan: Plan,
  combos: readonly WebCombination[],
  deps: {
    readonly specs: ReadonlyMap<string, string>;
    readonly blocked: ReadonlyMap<string, string>;
    readonly run: (combo: WebCombination, cases: Plan["cases"], dir: string) => Promise<unknown>;
    readonly unavailable: (combo: WebCombination) => string | undefined;
    /** Combinations at the same time (REQ-EXEC-19/AC3). */
    readonly concurrency: number;
  },
): Promise<void> {
  const cases = plan.cases.filter(
    (c) =>
      c.type === "web" &&
      !deps.blocked.has(c.id) &&
      deps.specs.has(c.id) &&
      !c.steps.some((s) => s.manual === true),
  );
  if (cases.length === 0) return;
  const one = async (combo: WebCombination): Promise<void> => {
    const dir = session.ws.path("results", "matrix", combo.id);
    await mkdir(dir, { recursive: true });
    const reason = deps.unavailable(combo);
    session.events.emit("run", SYSTEM, "matrix.combination", {
      combination: combo.id,
      blocked: reason !== undefined,
    });
    if (reason !== undefined) {
      for (const c of cases)
        await writeFile(
          join(dir, `${c.id}.json`),
          `${JSON.stringify(blockedResult(c.id, reason), null, 2)}\n`,
          {
            flag: "wx",
          },
        );
      return;
    }
    await deps.run(combo, cases, dir);
  };
  await runLimited(
    combos.map((combo) => () => one(combo)),
    deps.concurrency,
  );
}

/**
 * Runs the cases that list locales once more per locale (REQ-EXEC-14/AC1): the plan is resolved for the locale, so
 * expectations are that locale's formats from the approved plan (AC2); results go to `results/locale/<name>/`,
 * evidence under `locale/<name>/`. A locale missing from the project's `locales` makes those cases BLOCKED.
 * Mobile cases and cases with manual steps run in the primary run only.
 */
async function runLocales(
  session: RunSession,
  plan: Plan,
  deps: {
    readonly specs: ReadonlyMap<string, string>;
    readonly blocked: ReadonlyMap<string, string>;
    readonly run: (
      localePlan: Plan,
      locale: { name: string; timezone: string },
      dir: string,
    ) => Promise<unknown>;
  },
): Promise<void> {
  const runnable = plan.cases.filter(
    (c) =>
      c.type !== "mobile" &&
      !deps.blocked.has(c.id) &&
      deps.specs.has(c.id) &&
      !c.steps.some((s) => s.manual === true),
  );
  for (const name of [...new Set(runnable.flatMap((c) => c.locales ?? []))].sort()) {
    const localePlan = planForLocale({ ...plan, cases: runnable }, name);
    if (localePlan.cases.length === 0) continue;
    const dir = session.ws.path("results", "locale", name);
    await mkdir(dir, { recursive: true });
    const locale = session.project.config.locales.find((l) => l.name === name);
    session.events.emit("run", SYSTEM, "locale.run", { locale: name, cases: localePlan.cases.length });
    if (!locale) {
      for (const c of localePlan.cases)
        await writeFile(
          join(dir, `${c.id}.json`),
          `${JSON.stringify(blockedResult(c.id, `locale ${name} is not in the project's locales (qa.project.yaml)`), null, 2)}\n`,
          { flag: "wx" },
        );
      continue;
    }
    await deps.run(localePlan, locale, dir);
  }
}

/**
 * Prepares the mobile devices and runs the mobile lane on them (REQ-EXEC-06, REQ-EXEC-20): a platform that is not
 * available makes the mobile cases BLOCKED with the reason (REQ-ENV-06/AC3); the devices stop afterwards, also on
 * Ctrl+C.
 */
async function runMobile(
  session: RunSession,
  plan: Plan,
  mobileCases: Plan["cases"],
  io: CommandIO,
  results: Map<string, CaseResultFile>,
  options: {
    readonly sequential: boolean;
    readonly onDevice: (stop: () => Promise<void>) => void;
    readonly run: Parameters<typeof runMobileLane>[0]["run"];
    /** The devices, started once per run: before the author when it records the app's first screen (REQ-EXEC-22). */
    readonly device: () => Promise<PreparedMobile>;
  },
): Promise<Map<string, CaseResultFile>> {
  const { project } = session;
  const device = await options.device();
  if (!device.ok) {
    io.writeError(`Mobile cases are BLOCKED: ${device.reason}\n`);
    await writeBlocked(
      session,
      mobileCases.map((c) => c.id),
      `mobile device not available: ${device.reason}`,
      results,
    );
    return new Map();
  }
  options.onDevice(device.stop);
  try {
    return await runMobileLane({
      session,
      plan,
      cases: mobileCases,
      device,
      distribute: project.config.mobile?.distribute ?? "split",
      sequential: options.sequential,
      run: options.run,
      warn: io.writeError,
    });
  } finally {
    await device.stop();
  }
}

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
  const startedAt = ports.now().getTime();
  let release: (() => Promise<void>) | undefined;
  let messages: RunMessages | undefined;
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
        options.cases === undefined
          ? "This run already has results; start a new run to test again."
          : `This run already has results; to watch cases again start a new run: qajitsu fetch ${ws.ticket}, qajitsu approve ${ws.ticket} --reuse-from ${ws.runId}, then qajitsu run ${ws.ticket} --cases ${options.cases}.`,
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
    // REQ-ENV-08: message capture is checked against the allowlist before anything runs.
    messages = runMessages(session, ports);
    // REQ-WS-04/AC2: one process per run; other runs of the ticket may run in parallel.
    release = await acquireRunLock(ws.path("run.lock"));
    const { plan, approval } = await loadApprovedPlan(ws);
    // REQ-EXEC-16: chosen cases, a visible browser or emulator and step pauses are checked before anything runs.
    const live = prepareLiveRun(options, plan, io, events, {
      platform: ports.platform ?? process.platform,
      env: ports.env,
    });
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
        // REQ-OBS-10/AC1: the versions of every tool and model this run uses, recorded before anything runs.
        await ws.update({
          data: {
            ...ws.record.data,
            versions: await runVersions(project, { exec: ports.versionExec, playwright: ports.playwright }),
          },
        });
        const pending = await executeCases(session, plan, env, io, ports, results, {
          startedAt,
          user: options.user,
          messages,
          build: options.build === true,
          onDevice: (stop) => deviceStops.push(stop),
          live,
          sequential: options.sequential === true,
        });
        if (pending.length > 0)
          io.write(`Rejected spec files (not in the approved plan or misplaced): ${pending.join(", ")}\n`);
        // REQ-VER-06: the independent auditor reviews what PASSED; it can only downgrade. Regression runs call no
        // model (REQ-EXEC-17/AC1): their specs were audited when they passed and were promoted.
        const audit =
          ws.record.data["regression"] === undefined ? await auditRun(session, ports.now) : undefined;
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
    // REQ-VER-12: hints for FAILED cases, after the service logs are in logs/; they never change a status, so the
    // reports are only rendered again with the hints next to the computed results.
    if (
      ws.record.data["bench"] === undefined &&
      ws.record.data["regression"] === undefined &&
      verdict.cases.some((c) => c.status === "FAILED")
    ) {
      const triage = await triageRun(session, ports.now);
      if (triage?.status === "failed") io.writeError(`Failure hints not available: ${triage.error}\n`);
      if (triage) await writeReports(session, await computeVerdict(session, ports.now));
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
    // REQ-ENV-08/AC5: the run's inboxes are deleted when it ends, whatever the result.
    const problems = (await messages?.deleteAll().catch(() => ["inbox cleanup failed"])) ?? [];
    for (const p of problems) io.writeError(`Warning: an inbox was not deleted: ${p}\n`);
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
  run: {
    readonly build: boolean;
    readonly onDevice: (stop: () => Promise<void>) => void;
    readonly user?: string | undefined;
    readonly messages?: RunMessages | undefined;
    /** When the run started (epoch ms), for the time budget. */
    readonly startedAt?: number | undefined;
    /** Chosen cases, headed browser and step pauses (REQ-EXEC-16). */
    readonly live?: LiveRun | undefined;
    /** One case at a time (REQ-EXEC-19/AC2). */
    readonly sequential?: boolean | undefined;
  } = {
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
  const live = run.live;
  // Android unless only an iOS app is configured.
  const mobilePlatform =
    project.config.mobile?.ios && !project.config.mobile.android ? ("ios" as const) : ("android" as const);
  const devices = mobileDevices(session, env, ports, {
    build: run.build,
    headed: live?.headed === true,
    cases: plan.cases.filter((c) => c.type === "mobile").map((c) => c.id),
  });
  // REQ-EXEC-06: ui.goto() may open a deep link only when every configured native app declares a scheme.
  const apps = [project.config.mobile?.android, project.config.mobile?.ios].filter((a) => a !== undefined);
  const specChecks = { deepLinks: apps.length > 0 && apps.every((a) => a.deep_link_scheme !== undefined) };
  // REQ-EXEC-16/AC1: cases not chosen with --cases are not run (and get no spec); they are NOT_RUN, never PASSED.
  const notRun = new Map<string, string>();
  if (live?.selected)
    for (const c of plan.cases) if (!live.selected.has(c.id)) notRun.set(c.id, "not selected (--cases)");
  const missing = plan.cases.filter((c) => !existing.has(c.id) && !notRun.has(c.id));
  const blocked = new Map<string, string>();
  // REQ-PLAN-08/AC2: what this run will take, from the cases and the project's past runs.
  io.write(
    `${formatEstimate(plan, await readRunHistory(rootOf(project, ports), ws.runId), {
      web: Math.max(0, webCombinations(project.config.web).length - 1),
    })}\n`,
  );
  // REQ-PLAN-08/AC3: the run's budget; remaining cases are NOT_RUN with the reason once a limit is reached.
  const budget = project.config.budget;
  const startedAt = run.startedAt ?? ports.now().getTime();
  const timeStop = (): string | undefined =>
    budget.max_minutes !== undefined && ports.now().getTime() - startedAt >= budget.max_minutes * 60_000
      ? `the run's time budget (${String(budget.max_minutes)} min) was reached`
      : undefined;
  // REQ-EXEC-17/AC1+AC2: a regression run calls no agent or model; a case without a verified spec is BLOCKED.
  const regression = RegressionRunSchema.safeParse(ws.record.data["regression"]);
  if (regression.success) {
    for (const [caseId, reason] of Object.entries(regression.data.blocked)) blocked.set(caseId, reason);
    for (const c of missing)
      if (!blocked.has(c.id)) blocked.set(c.id, "regression pack has no spec for this case");
  } else if (missing.length > 0) {
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
      specChecks,
    };
    const context = await buildChangeContext(ws, [], { indexCache: codeIndexCache(project) });
    // REQ-EXEC-22: the author sees what the running application shows, recorded by this trusted code.
    const snapshot = await snapshotForAuthor(session, plan, missing, env, ports, {
      knownPages: context.ui?.pages ?? [],
      device: missing.some((c) => c.type === "mobile") ? devices.get : undefined,
      platform: mobilePlatform,
      io,
    });
    const authored = await runAuthor(
      deps,
      { ...plan, cases: missing },
      { ...context, ...(snapshot.length > 0 ? { snapshot } : {}) },
      analysis,
      Object.keys(env.profile.accounts),
      () =>
        timeStop() ??
        (budget.max_cost_usd !== undefined &&
        Number(ws.record.data["costUsd"] ?? 0) + usage.costUsd >= budget.max_cost_usd
          ? `the run's cost budget ($${budget.max_cost_usd.toFixed(2)}) was reached`
          : undefined),
    );
    await ws.update({ data: { ...ws.record.data, tokens: usage.total } });
    for (const a of authored)
      if (a.skipped !== undefined) notRun.set(a.caseId, a.skipped);
      else if (!a.file)
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
    const problems = await checkSpec(await readFile(file, "utf8"), caseId, plan, specChecks);
    if (notRun.has(caseId)) continue;
    if (problems.length > 0)
      blocked.set(caseId, `spec failed static checks: ${formatSpecProblems(problems)}`);
    else specs.set(caseId, file);
  }
  for (const [caseId, reason] of blocked) {
    events.emit("run", SYSTEM, "case.blocked", { caseId, reason: reason.slice(0, 500) });
    await writeBlocked(session, [caseId], reason, results);
  }
  for (const [caseId, reason] of notRun) {
    events.emit("run", SYSTEM, "case.not_run", { caseId, reason });
    const result = CaseResultFileSchema.parse({
      schema: 1,
      caseId,
      runner: "api",
      attempts: [{ attempt: 1, outcome: "skipped", assertions: [], error: reason, steps: [], evidence: [] }],
    });
    await writeFile(ws.path("results", `${caseId}.json`), `${JSON.stringify(result, null, 2)}\n`, {
      flag: "wx",
    });
    results.set(caseId, result);
    // Excluded from every execution below, like a blocked case, but recorded as NOT_RUN.
    blocked.set(caseId, reason);
  }
  // REQ-EXEC-13: the first browser and viewport combination is the primary run.
  const combos = webCombinations(project.config.web);
  const [primary] = combos;
  const executorFor = (combo: WebCombination | undefined): AttemptExecutor =>
    ports.executor ??
    createSandboxExecutor({
      // The browser starts only when a spec uses ui.* (REQ-EXEC-05, REQ-EXEC-07).
      browser: createPlaywrightBrowserFactory({
        browser: combo?.browser ?? project.config.web.browser,
        ...(combo ? { viewport: { width: combo.viewport.width, height: combo.viewport.height } } : {}),
        video: project.config.web.video,
        // REQ-EXEC-16/AC2: --headed shows the browser, --slow-mo slows every action down.
        headless: headlessFor(project.config.web.headless, live),
        slowMoMs: live?.slowMoMs,
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
  const executor = executorFor(primary);
  // REQ-EXEC-12: baselines are read from .qa/baselines/ by this trusted code; specs and agents never touch them.
  const visualFor = (variant: string): VisualCheck => ({
    variant,
    threshold: project.config.visual.threshold,
    baseline: (key) =>
      readFile(join(project.qaDir, "baselines", `${key}.png`)).then(
        (b) => new Uint8Array(b),
        () => undefined,
      ),
    compare: (baseline, actual) => compareImages(baseline, actual, project.config.visual.color_threshold),
  });
  const primaryVariant = primary?.id ?? "default";
  // The contract is read from the worktree, i.e. from exactly the analysed version of the code.
  let contract: ContractValidator | undefined;
  for (const [alias, repo] of Object.entries(project.config.repos)) {
    if (repo.openapi === undefined || ws.record.repos[alias] === undefined) continue;
    contract = await loadContractValidator(ws.path("repos", alias, repo.openapi));
    events.emit("run", SYSTEM, "contract.loaded", { repo: alias, file: repo.openapi });
    break;
  }
  const base = {
    // REQ-EXEC-11: manual steps ask a person here (terminal) or through manual/ files (CI); never an agent.
    manual: createManualPrompter(session, io, {
      user: run.user ?? "unknown",
      timeoutMs: project.config.manual.timeout_s * 1000,
    }),
    manualTimeoutMs: project.config.manual.timeout_s * 1000,
    stopReason: timeStop,
    ...(run.messages ? { messages: run.messages.forCase } : {}),
    visual: visualFor(primaryVariant),
    executor,
    baseUrl: env.baseUrl,
    allowedOrigins: [env.origin],
    // REQ-ENV-09: each attempt holds its own pool accounts while it runs.
    login: accountLogin(
      env,
      createAccountLeases(env.profile, { waitMs: project.config.execution.account_wait_s * 1000 }),
      {
        fetch: ports.fetch,
        qaDir: project.qaDir,
        resolveSecret: (r) => session.resolveSecret(r),
        registerSecret: (v) => {
          masker.register(v);
        },
      },
    ),
    contract,
    events,
    now: ports.now,
  };
  const evidence = createLocalEvidenceStore(ws.path("evidence"));
  // REQ-OBS-09/AC1+AC2: progress lines for the person running, live screenshots for `qj watch`.
  const total = plan.cases.filter((c) => !blocked.has(c.id) && specs.has(c.id)).length;
  const watched = {
    events: teeEvents(
      events,
      createProgressPrinter(io, plan, total, () => ports.now().getTime(), startedAt),
    ),
    onScreenshot: liveScreenshots(ws.path("live")),
  };
  // REQ-EXEC-19: API, web and mobile lanes run at the same time, each with its own cases at once; --sequential,
  // --headed and --step go one case at a time (REQ-EXEC-16/AC3, REQ-EXEC-19/AC5).
  const lanes = laneWorkers(project.config, {
    sequential: run.sequential === true || live?.pause !== undefined || live?.headed === true,
  });
  const active = plan.cases.filter((c) => !blocked.has(c.id));
  const ran = new Map<string, CaseResultFile>();
  const heal: RunCasesOptions["heal"] = async (caseId, specFile, failed, healAttempt) => {
    // Regression runs run the promoted specs as they are: no healing (REQ-EXEC-17/AC1).
    // REQ-EXEC-09 + REQ-EXEC-22/AC4: web and mobile cases are healed; API cases have no selectors.
    const type = plan.cases.find((c) => c.id === caseId)?.type;
    if (regression.success || (type !== "web" && type !== "mobile")) return undefined;
    const usage = createUsageTracker({
      events,
      budget: project.config.models.token_budget,
      alreadyUsed: Number(ws.record.data["tokens"] ?? 0),
    });
    const dom = failed.evidence.find((e) => e.name === "failure.html")?.content;
    const recorded = failed.evidence.find((e) => e.name === "failure-elements.json")?.content;
    let elements: UiElementFact[] | undefined;
    try {
      elements = typeof recorded === "string" ? (JSON.parse(recorded) as UiElementFact[]) : undefined;
    } catch {
      elements = undefined;
    }
    const { file } = await healSpec(
      {
        ws,
        models: session.models,
        events,
        usage,
        now: ports.now,
        maskJson: (v: unknown) => masker.maskJson(v),
        maskText: (t: string) => masker.maskText(t),
        specChecks,
      },
      plan,
      {
        caseId,
        specFile,
        error: masker.maskText(failed.error ?? "unknown error"),
        dom: typeof dom === "string" ? dom : undefined,
        ...(elements
          ? {
              screen: {
                where: "the failure",
                platform: type === "web" ? ("web" as const) : mobilePlatform,
                elements,
              },
            }
          : {}),
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
  };
  const primaryLane = (lane: "api" | "web") => async (): Promise<void> => {
    const cases = active.filter((c) => c.type === lane);
    if (cases.length === 0) return;
    events.emit("run", SYSTEM, "lane.start", { lane, cases: cases.length, workers: lanes[lane] });
    const laneRan = await runCases({
      ...base,
      ...watched,
      // REQ-EXEC-16/AC3: only the primary run pauses; one case at a time so the person follows one.
      ...(live?.pause ? { pause: live.pause } : {}),
      lane,
      plan: { ...plan, cases },
      specs,
      evidence,
      resultsDir: ws.path("results"),
      retries: project.config.environments.retries,
      workers: lanes[lane],
      // REQ-EXEC-09: web cases that could not run get at most two healed attempts.
      ...(lane === "web" ? { heal } : {}),
    });
    for (const [id, r] of laneRan) ran.set(id, r);
  };
  const matrix = (concurrency: number) => (): Promise<void> =>
    runMatrix(session, plan, combos.slice(1), {
      specs,
      blocked,
      concurrency,
      run: (combo, cases, dir) =>
        runCases({
          ...base,
          lane: "web",
          executor: executorFor(combo),
          plan: { ...plan, cases },
          specs,
          evidence,
          resultsDir: dir,
          evidencePrefix: `matrix/${combo.id}/`,
          visual: visualFor(combo.id),
          retries: project.config.environments.retries,
          workers: lanes.web,
        }),
      unavailable: (combo) =>
        ports.browserUnavailable
          ? ports.browserUnavailable(combo.browser)
          : ports.executor
            ? undefined
            : browserUnavailable(combo.browser),
    });
  const mobileCases = active.filter((c) => c.type === "mobile" && specs.has(c.id));
  const mobileRan = new Map<string, CaseResultFile>();
  const mobileLane = async (): Promise<void> => {
    if (mobileCases.length === 0) {
      // Started for the snapshot but nothing to run on it: stop it now.
      if (devices.started()) {
        const d = await devices.get();
        if (d.ok) await d.stop();
      }
      return;
    }
    for (const [id, r] of await runMobile(session, plan, mobileCases, io, results, {
      device: devices.get,
      onDevice: run.onDevice,
      sequential: lanes.sequential,
      run: (factory, cases, where) =>
        runCases({
          ...base,
          ...(where.primary ? watched : {}),
          lane: "mobile",
          executor: ports.mobileExecutor?.(factory) ?? createSandboxExecutor({ browser: factory }),
          ...(live?.pause && where.primary ? { pause: live.pause } : {}),
          plan: { ...plan, cases },
          specs: new Map([...specs].filter(([id]) => cases.some((c) => c.id === id))),
          evidence,
          resultsDir: where.resultsDir,
          ...(where.evidencePrefix ? { evidencePrefix: where.evidencePrefix } : {}),
          retries: project.config.environments.retries,
          workers: 1,
          // REQ-EXEC-22/AC4: the primary device heals like the web lane.
          ...(where.primary ? { heal } : {}),
        }),
    }))
      mobileRan.set(id, r);
  };
  // REQ-EXEC-19/AC3: with web_combinations > 1 the other browsers run next to the primary one.
  const together = lanes.webCombinations > 1;
  await runLimited(
    [
      primaryLane("api"),
      primaryLane("web"),
      mobileLane,
      ...(together ? [matrix(lanes.webCombinations - 1)] : []),
    ],
    lanes.sequential ? 1 : 4,
  );
  if (!together) await matrix(1)();
  // REQ-VER-09: the canary re-runs one PASSED case with an inverted expectation; it must fail.
  if (project.config.verification.canary) await runCanary(session, plan, ran, specs, base);
  for (const [id, r] of mobileRan) ran.set(id, r);
  for (const [id, r] of ran) results.set(id, r);
  await runLocales(session, plan, {
    specs,
    blocked,
    run: (localePlan, locale, dir) =>
      runCases({
        ...base,
        executor: executorFor(primary),
        plan: localePlan,
        specs,
        evidence,
        resultsDir: dir,
        evidencePrefix: `locale/${locale.name}/`,
        visual: visualFor(`${primaryVariant}-${locale.name}`),
        locale,
        retries: project.config.environments.retries,
        workers: lanes.api,
      }),
  });
  events.emit("run", RUNNER, "cases.done", { cases: ran.size });
  return rejected.map((f) => f.slice(ws.dir.length + 1));
}
