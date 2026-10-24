import { httpCredentialsFor } from "../http-auth.js";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { runUsage, saveRunUsage } from "../run-usage.js";
import { createLocalEvidenceStore } from "@qajitsu/adapter-evidence-local";
import { createRemoteEnvProvider, loginAccounts } from "@qajitsu/adapter-env-remote";
import type { BrowserFactory } from "@qajitsu/adapter-runner-api";
import { createPlaywrightBrowserFactory } from "@qajitsu/adapter-runner-web";
import { buildChangeContext, runExplorer, type ExplorerReport } from "@qajitsu/agents";
import {
  CliExploreSessionSchema,
  ConfigError,
  ExploreSessionSchema,
  QajitsuError,
  acquireRunLock,
  listPlanVersions,
  readPlan,
  writePlanVersion,
  type EventLog,
  type ExploreSession,
  type Plan,
  type TestCase,
} from "@qajitsu/core";
import { renderExploreHtml, renderExploreMarkdown } from "@qajitsu/report";
import { createMasker } from "@qajitsu/steps";
import type { RuntimePorts } from "../adapters.js";
import { codeIndexCache, openSession, type ModelPorts, type RunSession } from "../session.js";
import { printable } from "./cli-terminal.js";
import { checkOption, checklistLine, sessionClaims } from "./explore-checklist.js";
import { createExploreTools } from "./explore-tools.js";
import type { CommandIO } from "./fetch.js";
import { writeCliPromotion, type CliExplorePorts } from "./explore-cli.js";
import { runningBuild } from "./env-up-reuse.js";
import { headlessFor, liveView } from "./live.js";
import { chooseEnvironment, type RunPorts } from "./run.js";

const SYSTEM = { kind: "system", name: "orchestrator" } as const;

/** Options of `qajitsu explore`. */
export interface ExploreOptions {
  readonly run?: string | undefined;
  /** Required: what to explore (validated here; a required option would also bind `explore promote`). */
  readonly goal?: string | undefined;
  readonly env?: string | undefined;
  /** Minutes; default 10. */
  readonly timeBox?: string | undefined;
  /** Browser actions; default 40. */
  readonly maxSteps?: string | undefined;
  /** Show the browser while the agent explores (REQ-EXEC-15/AC7). */
  readonly headed?: boolean | undefined;
  /** Delay before every browser action, in ms. */
  readonly slowMo?: string | undefined;
  /** Explore this command-line tool of `explore.cli` instead of the application in a browser (REQ-EXEC-24). */
  readonly cli?: string | undefined;
  /** The goal's checklist, item by item (REQ-EXEC-25/AC1). */
  readonly check?: readonly string[] | undefined;
}

/** Ports of `qajitsu explore`: the browser can be replaced in tests. */
export interface ExplorePorts extends CliExplorePorts {
  readonly exploreBrowser?: BrowserFactory;
}

const fail = (io: CommandIO, error: unknown, mask: (t: string) => string): number => {
  const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
  io.writeError(mask(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`));
  return 3;
};

/** A positive number option (minutes, actions), or its default; anything else is `OPTION_INVALID`. */
export const numberOption = (
  raw: string | undefined,
  fallback: number,
  name: string,
  max: number,
): number => {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > max)
    throw new ConfigError("OPTION_INVALID", `${name} must be a number between 0 and ${String(max)}.`, {});
  return n;
};

/** The next free exploratory session id of a run (`S01`, `S02`, ...), shared by browser and CLI sessions. */
export const nextSessionId = async (session: RunSession): Promise<string> => {
  const used = (await readdir(session.ws.path("explore")).catch(() => [] as string[]))
    .map((d) => /^S(\d{2,3})$/.exec(d)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  return `S${String(Math.max(0, ...used) + 1).padStart(2, "0")}`;
};

/**
 * `qajitsu explore <TICKET> --goal <text> [--time-box <min>] [--max-steps <n>] [--env <profile|url>]`: an
 * exploratory session (REQ-EXEC-15). The explorer agent asks for browser actions; the trusted parent performs them
 * in a browser limited to the environment allowlist, records a screenshot after each one, the video, trace, network
 * and console, and journals everything. The session produces observations for a person and a review report
 * (`explore/<session>/report.html`), never test results or statuses. Time box and step budget are enforced by code.
 *
 * @returns 0 when the session ran (whatever it observed), 2 when the environment is not healthy, 3 on errors.
 */
export async function runExplore(
  rawKey: string,
  options: ExploreOptions,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts & RunPorts & ExplorePorts,
): Promise<number> {
  // REQ-EXEC-24: a command-line tool instead of the application in a browser.
  if (options.cli !== undefined) {
    const { runCliExplore } = await import("./explore-cli.js");
    return runCliExplore(rawKey, { ...options, cli: options.cli }, io, ports);
  }
  const masker = createMasker();
  let release: (() => Promise<void>) | undefined;
  try {
    const goal = (options.goal ?? "").trim();
    if (goal === "")
      throw new ConfigError(
        "OPTION_INVALID",
        '--goal is required: say what to explore, e.g. --goal "checkout".',
        {},
      );
    const checks = checkOption(options.check);
    const minutes = numberOption(options.timeBox, 10, "--time-box", 240);
    const maxSteps = Math.floor(numberOption(options.maxSteps, 40, "--max-steps", 1000));
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const { ws, events, project } = session;
    if (!ws.record.checkpoints.some((c) => c.stage === "fetch"))
      throw new ConfigError(
        "RUN_NOT_FETCHED",
        `Run ${ws.runId} has no fetched context; run 'qajitsu fetch' first.`,
        {},
      );
    release = await acquireRunLock(ws.path("run.lock"));
    const view = liveView(options, { platform: ports.platform ?? process.platform, env: ports.env });
    // REQ-EXEC-15/AC1: only an allowlisted environment (invariant 10).
    const built = options.env === undefined ? await runningBuild(session, ports.fetch) : undefined;
    if (built) io.write(`Using the environment qj env up started for this run: ${built.baseUrl}\n`);
    const env = built ?? (await chooseEnvironment(session, io, options.env));
    const reached = await createRemoteEnvProvider(env, ports.fetch, { readVersion: false }).start();
    if (!reached.health.ok) {
      io.writeError(
        `Environment ${env.name} is not healthy (${reached.health.detail}); no session started.\n`,
      );
      return 2;
    }
    const login =
      env.profile.login && Object.keys(env.profile.accounts).length > 0
        ? await loginAccounts(env, {
            fetch: ports.fetch,
            qaDir: project.qaDir,
            resolveSecret: (r) => session.resolveSecret(r),
            registerSecret: (v) => {
              masker.register(v);
            },
          }).catch((error: unknown) => {
            io.writeError(
              masker.maskText(
                `Warning: login failed, exploring without accounts: ${error instanceof Error ? error.message : String(error)}\n`,
              ),
            );
            return undefined;
          })
        : undefined;
    const id = await nextSessionId(session);
    const dir = ws.path("explore", id);
    await mkdir(dir, { recursive: true });
    const store = createLocalEvidenceStore(ws.path("explore", id, "evidence"));
    const startedAt = ports.now().toISOString();
    events.emit("explore", SYSTEM, "explore.start", {
      session: id,
      goal,
      ...(checks.length > 0 ? { checks } : {}),
      env: env.name,
      minutes,
      maxSteps,
      headed: view.headed,
      ...(view.slowMoMs ? { slowMoMs: view.slowMoMs } : {}),
    });
    io.write(
      `Exploratory session ${id} on ${env.name} (${env.baseUrl}): ${String(minutes)} min, ${String(maxSteps)} actions\n`,
    );

    const httpCredentials = await httpCredentialsFor(env, session.resolveSecret);
    const factory =
      ports.exploreBrowser ??
      createPlaywrightBrowserFactory({
        ...(httpCredentials ? { httpCredentials } : {}),
        browser: project.config.web.browser,
        video: "always",
        // REQ-EXEC-15/AC7: --headed shows the browser, --slow-mo slows every action down to watch it.
        headless: headlessFor(project.config.web.headless, view),
        ...(view.slowMoMs ? { slowMoMs: view.slowMoMs } : {}),
        actionTimeoutMs: project.config.web.action_timeout_ms,
        webSession: env.profile.web_session,
      });
    const browser = factory({
      specFile: "",
      caseId: "explore",
      attempt: 1,
      // The browser reads only URLs, accounts and sessions; an exploratory session has no plan.
      plan: {
        schema: 1,
        ticket: ws.ticket,
        version: 0,
        summary: "",
        cases: [],
        open_questions: [],
        out_of_scope: [],
        existing_coverage: [],
      } as unknown as Plan,
      baseUrl: env.baseUrl,
      allowedOrigins: [env.origin],
      accounts: login?.accounts ?? {},
      secrets: login?.secrets ?? [],
      timeoutMs: 30_000,
      ...(login ? { sessions: login.sessions } : {}),
    });
    const accounts = login ? Object.keys(login.sessions) : [];
    // Exploratory testing F23: each action, rejected answer and observation shows as it happens, as in --cli sessions.
    const watched: EventLog = {
      emit(stage, actor, event, details) {
        events.emit(stage, actor, event, details);
        const d = (details ?? {}) as {
          id?: string;
          action?: string;
          target?: string;
          ok?: boolean;
          error?: string;
          url?: string;
          errors?: string[];
          severity?: string;
          title?: string;
        };
        const line =
          event === "explore.action"
            ? `${d.id ?? ""}  ${d.action ?? ""} ${d.target ?? ""} → ${d.ok === true ? "ok" : `failed: ${d.error ?? ""}`}`
            : event === "explore.answer_rejected"
              ? `✘ answer rejected: ${(d.errors ?? []).join("; ")}`
              : event === "explore.observation"
                ? `● ${d.id ?? ""} [${d.severity ?? ""}] ${d.title ?? ""}`
                : undefined;
        if (line !== undefined) io.write(`${printable(masker.maskText(line))}\n`);
      },
    };
    const recorder = createExploreTools({
      driver: await browser.driver(),
      store,
      mask: (t) => masker.maskText(t),
      events: watched,
      maxSteps,
      accounts,
      now: ports.now,
    });
    // REQ-EXEC-15/AC5: the time box is a timer in code, not a request to the model.
    const timeBox = new AbortController();
    const timer = setTimeout(() => {
      timeBox.abort();
    }, minutes * 60_000);
    let endReason: ExploreSession["endReason"] = "finished";
    let summary = "";
    let report: ExplorerReport | undefined;
    let error: string | undefined;
    let modelId = "";
    try {
      modelId = (await session.models.forRole("explorer")).id;
      const usage = runUsage(session);
      const result = await runExplorer(
        {
          ws,
          models: session.models,
          events: watched,
          usage,
          now: ports.now,
          maskJson: (v: unknown) => masker.maskJson(v),
          maskText: (t: string) => masker.maskText(t),
        },
        {
          goal,
          context: await buildChangeContext(ws, [], {
            indexCache: codeIndexCache(project),
            testIdAttribute: project.config.web.test_id_attribute,
          }),
          tools: recorder.tools,
          accounts,
          session: {
            actions: () => recorder.actions,
            budgetLeft: () => !recorder.exhausted(),
            checks,
          },
          // Looks do not count as actions; the loop gets room for them on top of the action budget.
          maxSteps: maxSteps * 2 + 10,
          signal: timeBox.signal,
        },
      );
      report = result;
      summary = masker.maskText(result.summary);
      if (recorder.exhausted()) endReason = "step-budget";
      await saveRunUsage(ws, usage);
    } catch (e) {
      if (timeBox.signal.aborted) endReason = "time-box";
      else if (recorder.exhausted()) endReason = "step-budget";
      else {
        endReason = "error";
        error = masker
          .maskText((e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "")
          .slice(0, 2000);
      }
    } finally {
      clearTimeout(timer);
    }
    // Session recordings, written by the trusted parent with hashes in the manifest (REQ-EXEC-15/AC2).
    const recordings: string[] = [];
    for (const item of await browser.close(true).catch(() => [])) {
      const stored = await store.put(
        { path: `recordings/${item.name}`, caseId: "explore", stepId: "session", kind: item.kind },
        typeof item.content === "string" ? new TextEncoder().encode(item.content) : item.content,
      );
      recordings.push(stored.path);
    }
    const record = ExploreSessionSchema.parse({
      schema: 1,
      id,
      ticket: ws.ticket,
      run: ws.runId,
      goal: masker.maskText(goal),
      environment: { name: env.name, baseUrl: env.baseUrl },
      model: modelId,
      startedAt,
      endedAt: ports.now().toISOString(),
      endReason,
      ...(error !== undefined ? { error } : {}),
      budget: { minutes, steps: maxSteps },
      summary,
      ...sessionClaims(checks, report, endReason, (t) => masker.maskText(t)),
      actions: recorder.actions,
      observations: recorder.observations,
      recordings,
    });
    const manifest = await store.manifest();
    await writeFile(ws.path("explore", id, "session.json"), `${JSON.stringify(record, null, 2)}\n`, {
      flag: "wx",
    });
    await writeFile(ws.path("explore", id, "report.md"), renderExploreMarkdown(record, manifest));
    await writeFile(ws.path("explore", id, "report.html"), renderExploreHtml(record, manifest));
    events.emit("explore", SYSTEM, "explore.end", {
      session: id,
      endReason,
      actions: record.actions.length,
      observations: record.observations.length,
    });
    io.write(
      [
        `Session ${id} ended: ${endReason}${error ? ` (${error})` : ""}; ${String(record.actions.length)} actions, ${String(record.observations.length)} observation(s).`,
        ...[checklistLine(record.checklist)].filter((l) => l !== undefined),
        ...record.observations.map((o) => `  ${o.id} [${o.severity}] ${o.title}`),
        `Report: ${ws.path("explore", id, "report.html")}`,
        record.observations.length > 0
          ? `Turn an observation into a plan case: qajitsu explore promote ${ws.ticket} --run ${ws.runId} --session ${id} --observation O1`
          : "",
        "",
      ]
        .filter((l, i, all) => l !== "" || i === all.length - 1)
        .map(printable)
        .join("\n"),
    );
    return 0;
  } catch (error) {
    return fail(io, error, (t) => masker.maskText(t));
  } finally {
    await release?.();
  }
}

/**
 * `qajitsu explore promote <TICKET> --session <S01> --observation <O1>`: turns an observation into a draft web case
 * in a new plan version, citing the observation as its source (REQ-EXEC-15/AC4). The steps replay the recorded
 * actions; the expectation is the observation's "expected". Nothing runs until a person approves the plan.
 *
 * @returns 0 when the plan version was written, 3 on errors (unknown session or observation, approved plan).
 */
export async function runExplorePromote(
  rawKey: string,
  options: { readonly run?: string | undefined; readonly session: string; readonly observation: string },
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
): Promise<number> {
  const masker = createMasker();
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const { ws } = session;
    if (!/^S\d{2,3}$/.test(options.session))
      throw new ConfigError("EXPLORE_SESSION_NOT_FOUND", `No exploratory session ${options.session}.`, {});
    const raw = JSON.parse(
      await readFile(ws.path("explore", options.session, "session.json"), "utf8").catch(() => {
        throw new ConfigError("EXPLORE_SESSION_NOT_FOUND", `No exploratory session ${options.session}.`, {});
      }),
    ) as { kind?: unknown };
    // REQ-EXEC-24/AC6: a command-line session becomes a regression test proposal, not a plan case.
    if (raw.kind === "cli") {
      const file = await writeCliPromotion(
        CliExploreSessionSchema.parse(raw),
        options.observation,
        ws.path("explore", options.session),
      );
      session.events.emit("explore", { kind: "user", name: "cli" }, "explore.promoted", {
        session: options.session,
        observation: options.observation,
        proposal: file.slice(ws.dir.length + 1),
      });
      io.write(
        `Regression test proposal written: ${file}\nNothing runs until it is added to a test suite.\n`,
      );
      return 0;
    }
    if (ws.record.data["approval"] !== undefined)
      throw new ConfigError(
        "PLAN_ALREADY_APPROVED",
        "The plan of this run is approved and frozen; explore and promote in a new run.",
        {},
      );
    const record = ExploreSessionSchema.parse(raw);
    const observation = record.observations.find((o) => o.id === options.observation);
    if (!observation)
      throw new ConfigError(
        "OBSERVATION_NOT_FOUND",
        `Session ${record.id} has no observation ${options.observation}.`,
        { available: record.observations.map((o) => o.id) },
      );
    const previous = (await listPlanVersions(ws)).length > 0 ? (await readPlan(ws)).plan : undefined;
    const used = (previous?.cases ?? []).map((c) => Number(c.id.slice(3)));
    const caseId = `TC-${String(Math.max(0, ...used) + 1).padStart(2, "0")}`;
    const actions = new Map(record.actions.map((a) => [a.id, a]));
    const steps = observation.steps.map((actionId, i) => {
      const a = actions.get(actionId);
      const last = i === observation.steps.length - 1;
      return {
        id: `S${String(i + 1)}`,
        action: a ? `${a.action} ${a.target}${a.value !== undefined ? ` "${a.value}"` : ""}` : actionId,
        expect: {
          description: last
            ? observation.expected || `Not as observed: ${observation.actual || observation.title}`
            : "The action succeeds",
        },
      };
    });
    const draftCase: TestCase = {
      id: caseId,
      title: observation.title,
      type: "web",
      priority: observation.severity,
      reproduces: false,
      source: [{ kind: "observation", session: record.id, id: observation.id }],
      preconditions: [
        `From exploratory session ${record.id} ${observation.id}: ${observation.description}`.slice(0, 500),
      ],
      data: {},
      steps,
      evidence: ["screenshot"],
    };
    const plan = await writePlanVersion(ws, {
      summary: previous?.summary ?? `Cases from exploratory session ${record.id}.`,
      cases: [...(previous?.cases ?? []), draftCase],
      open_questions: previous?.open_questions ?? [],
      out_of_scope: previous?.out_of_scope ?? [],
      existing_coverage: previous?.existing_coverage ?? [],
      selection: previous?.selection ?? [],
      ...(previous?.depth ? { depth: previous.depth } : {}),
    });
    session.events.emit("explore", { kind: "user", name: "cli" }, "explore.promoted", {
      session: record.id,
      observation: observation.id,
      caseId,
      planVersion: plan.version,
    });
    io.write(
      `${caseId} added to plan v${String(plan.version)} from ${record.id} ${observation.id}. Review and approve it: qajitsu plan ${ws.ticket} --run ${ws.runId} or qajitsu approve ${ws.ticket} --run ${ws.runId}\n`,
    );
    return 0;
  } catch (error) {
    return fail(io, error, (t) => masker.maskText(t));
  }
}
