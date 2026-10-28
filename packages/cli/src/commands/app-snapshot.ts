import { httpCredentialsFor } from "../http-auth.js";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteEnvProvider } from "@qajitsu/adapter-env-remote";
import type { BrowserFactory } from "@qajitsu/adapter-runner-api";
import { createPlaywrightBrowserFactory } from "@qajitsu/adapter-runner-web";
import {
  createAccountLeases,
  resolveEnvironment,
  type ResolvedEnvironment,
  type Plan,
  type RunWorkspace,
  type UiScreen,
} from "@qajitsu/core";
import type { CommandExec } from "@qajitsu/adapter-env-compose";
import type { CodeHost } from "@qajitsu/core";
import { buildAdapters, type RuntimePorts } from "../adapters.js";
import { acquireEnvLock, prepareBuild, removeEnvFiles, type PreparedBuild } from "./build-env.js";
import type { RunSession } from "../session.js";
import type { CommandIO } from "./fetch.js";
import { accountLogin } from "./lanes.js";
import { prepareMobile, type PreparedMobile } from "./mobile.js";
import { crawlUiSnapshot, recordStartScreen, recordUiSnapshot, type UiSnapshotInput } from "./ui-snapshot.js";

/** Ports of the snapshot: a browser replaced in tests (default: headless Playwright). */
export interface SnapshotPorts {
  readonly snapshotBrowser?: BrowserFactory;
  /** Device for the app's first screen before planning (replaced in tests); default: the mobile config. */
  readonly mobileDevice?: () => Promise<PreparedMobile>;
  /** Runs docker and other commands of `qj plan --build` (replaced in tests). */
  readonly buildExec?: CommandExec;
  /** A fake executor of tests: without `snapshotBrowser` no real browser is started for a snapshot. */
  readonly executor?: unknown;
}

const FILE = ["ui", "snapshot.json"] as const;

/**
 * The pages recorded before planning (REQ-EXEC-22/AC7), from `ui/snapshot.json` of the run; undefined when none.
 *
 * @param ws - The run workspace.
 */
export async function readPlanSnapshot(ws: RunWorkspace): Promise<UiScreen[] | undefined> {
  try {
    return JSON.parse(await readFile(ws.path(...FILE), "utf8")) as UiScreen[];
  } catch {
    return undefined;
  }
}

/** The headless browser of snapshots for an environment, or the test's replacement. */
export function snapshotBrowser(
  session: RunSession,
  env: ResolvedEnvironment,
  ports: SnapshotPorts,
  httpCredentials?: { readonly username: string; readonly password: string },
): BrowserFactory {
  const web = session.project.config.web;
  return (
    ports.snapshotBrowser ??
    createPlaywrightBrowserFactory({
      browser: web.browser,
      video: "off",
      headless: true,
      actionTimeoutMs: web.action_timeout_ms,
      testIdAttribute: web.test_id_attribute,
      webSession: env.profile.web_session,
      ...(httpCredentials ? { httpCredentials } : {}),
      observations: { console: false, httpErrors: false, accessibility: false },
    })
  );
}

/**
 * Logs account aliases in for a snapshot as an attempt would (pool accounts held until released, secrets registered
 * with the masker). The login reads the aliases from a file, as it does from a spec.
 */
export function snapshotLogin(
  session: RunSession,
  env: ResolvedEnvironment,
  ports: RuntimePorts,
  scratch: string,
): NonNullable<UiSnapshotInput["web"]>["login"] {
  const { project, masker } = session;
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
  return async (aliases) => {
    const file = join(scratch, `${aliases.join("-").replace(/[^\w-]/g, "_")}.txt`);
    await writeFile(file, aliases.join("\n"), "utf8");
    return login({ caseId: "snapshot", attempt: 0, specFile: file, lane: "web" });
  };
}

/**
 * Records the environment's pages for the planner (REQ-EXEC-22/AC7): when the run has no code of the application
 * (only a tests repository or none), when its change shows no diff, or when asked with `--snapshot`. An earlier recording of the run is reused unless
 * asked again. Without a reachable environment the planner works without it and the person is told (AC6).
 *
 * @returns The recorded pages, or undefined.
 */
export async function planSnapshot(
  session: RunSession,
  io: CommandIO,
  ports: RuntimePorts & SnapshotPorts,
  options: {
    readonly env?: string | undefined;
    readonly force: boolean;
    readonly build?: boolean;
    /** Pages the code defines, recorded too (dogfood pass 2026-10-25). */
    readonly paths?: readonly string[] | undefined;
  },
): Promise<UiScreen[] | undefined> {
  const { ws, events, masker } = session;
  const saved = await readPlanSnapshot(ws);
  if (saved && !options.force && options.build !== true) return saved;
  const hasCode = Object.values(ws.record.repos).some((r) => r.role !== "tests");
  // Code without a visible change (a branch named by --ref with no diff) shows the planner nothing of the pages either
  // (dogfood pass 2026-10-25: it guessed every text), so the pages are recorded then too.
  const diffs = (await readdir(ws.path("repos")).catch(() => [] as string[])).filter((f) =>
    f.endsWith(".diff"),
  );
  const changeShown = await Promise.all(
    diffs.map((f) =>
      stat(ws.path("repos", f)).then(
        (x) => x.size > 0,
        () => false,
      ),
    ),
  ).then((sizes) => sizes.some(Boolean));
  if (hasCode && changeShown && !options.force && options.build !== true) return undefined;
  if (options.build !== true)
    return recordForPlanner(session, io, ports, {
      env: options.env,
      force: options.force,
      paths: options.paths,
    });
  // REQ-EXEC-22/AC9: the environment (and the app) are started from the worktree only to record what they show.
  const releaseEnv = await acquireEnvLock(session);
  io.write("Building the environment to record its pages and screens for the planner…\n");
  const prepared = await prepareBuild(session, {
    overrides: {},
    exec: ports.buildExec,
    fetch: ports.fetch,
  }).catch((error: unknown): PreparedBuild => ({
    failure: { message: error instanceof Error ? error.message : String(error), logs: [] },
  }));
  events.emit("plan", { kind: "system", name: "orchestrator" }, "env.build", {
    ok: prepared.failure === undefined,
    ...(prepared.failure ? { error: masker.maskText(prepared.failure.message) } : {}),
  });
  try {
    if (prepared.failure || !prepared.build) {
      io.writeError(
        `The environment did not start (${masker.maskText(prepared.failure?.message ?? "no environment")}); planning without its pages.\n`,
      );
      return undefined;
    }
    return await recordForPlanner(session, io, ports, {
      env: options.env,
      force: true,
      buildBaseUrl: prepared.build.baseUrl,
      paths: options.paths,
    });
  } finally {
    await prepared.build?.stop().catch(() => undefined);
    await removeEnvFiles(session);
    await releaseEnv();
  }
}

/** The code hosts of the project, for an app built by CI (REQ-ENV-06/AC1). */
const codeHostsOf = (session: RunSession, ports: RuntimePorts): Readonly<Record<string, CodeHost>> =>
  buildAdapters(
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
  ).codeHosts;

/** Records the environment's pages and the app's first screen into `ui/snapshot.json` (REQ-EXEC-22/AC7+AC9). */
async function recordForPlanner(
  session: RunSession,
  io: CommandIO,
  ports: RuntimePorts & SnapshotPorts,
  options: {
    readonly env?: string | undefined;
    readonly force: boolean;
    readonly buildBaseUrl?: string;
    readonly paths?: readonly string[] | undefined;
  },
): Promise<UiScreen[] | undefined> {
  const { ws, project, masker, events } = session;
  let env: ResolvedEnvironment;
  try {
    env = await resolveEnvironment({
      config: project.config,
      qaDir: project.qaDir,
      env: options.env,
      ...(options.buildBaseUrl ? { buildBaseUrl: options.buildBaseUrl } : {}),
    });
  } catch (error) {
    io.writeError(
      `No environment to record pages from (${error instanceof Error ? error.message : String(error)}); planning without them.\n`,
    );
    return undefined;
  }
  const reached = await createRemoteEnvProvider(env, ports.fetch, {
    readVersion: options.buildBaseUrl === undefined,
  }).start();
  if (!reached.health.ok) {
    io.writeError(
      `Environment ${env.name} is not reachable (${reached.health.detail}); planning without its pages.\n`,
    );
    return undefined;
  }
  const account = env.profile.web_session ? Object.keys(env.profile.accounts)[0] : undefined;
  const scratch = await mkdtemp(join(tmpdir(), "qj-snapshot-"));
  try {
    const screens = await crawlUiSnapshot({
      factory: snapshotBrowser(session, env, ports, await httpCredentialsFor(env, session.resolveSecret)),
      login: snapshotLogin(session, env, ports, scratch),
      account,
      baseUrl: env.baseUrl,
      allowedOrigins: [env.origin],
      ...(options.paths ? { paths: options.paths } : {}),
      testStateHook: project.config.web.test_state,
      mask: (v) => masker.maskJson(v),
      emit: (event, details) => {
        events.emit("plan", { kind: "system", name: "orchestrator" }, event, details);
        if (event === "ui.snapshot.failed")
          io.writeError(`Could not record ${String(details["where"])}: ${String(details["error"])}\n`);
      },
    });
    // AC7: the first screen of a mobile app that needs no repository (a file, a download, an installed app or a farm).
    const mobile = project.config.mobile;
    const appWithoutCode =
      mobile?.android !== undefined
        ? ["file", "url", "installed"].includes(mobile.android.app.source)
        : mobile?.ios?.farm !== undefined;
    if (mobile && (appWithoutCode || options.force)) {
      const device = await (ports.mobileDevice?.() ??
        prepareMobile(session, env.baseUrl, codeHostsOf(session, ports), ports.env["APPIUM_HOME"], {
          // AC9: with qj plan --build the app may be built from the worktree too.
          allowBuild: options.buildBaseUrl !== undefined,
          fetch: ports.fetch,
        }));
      if (!device.ok) io.writeError(`Could not record the app's first screen: ${device.reason}\n`);
      else
        try {
          const screen = device.factories[0]
            ? await recordStartScreen({
                factory: device.factories[0],
                platform: mobile.android ? "android" : "ios",
                plan: { schema: 1, ticket: ws.ticket, version: 1, summary: "", cases: [] } as unknown as Plan,
                caseId: "TC-00",
                mask: (v) => masker.maskJson(v),
                emit: (event, details) => {
                  events.emit("plan", { kind: "system", name: "orchestrator" }, event, details);
                  if (event === "ui.snapshot.failed")
                    io.writeError(`Could not record the app's first screen: ${String(details["error"])}\n`);
                },
              })
            : undefined;
          if (screen) screens.push(screen);
        } finally {
          await device.stop();
        }
    }
    await mkdir(ws.path("ui"), { recursive: true });
    await writeFile(ws.path(...FILE), `${JSON.stringify(screens, null, 2)}\n`, "utf8");
    io.write(`Recorded ${String(screens.length)} page(s) or screen(s) of ${env.name} for the planner.\n`);
    return screens;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Records the pages and screens the author will see in `qj run` (REQ-EXEC-22/AC1): the web cases' pages through a
 * headless browser with the run's logins and allowlist, the first screen of the app on the run's device, plus the
 * pages recorded before planning. Failures are journaled and shown; the author goes on without them (AC6).
 */
export async function authorSnapshot(
  session: RunSession,
  plan: Plan,
  cases: Plan["cases"],
  env: ResolvedEnvironment,
  ports: RuntimePorts & SnapshotPorts,
  options: {
    readonly knownPages: readonly string[];
    readonly device: (() => Promise<PreparedMobile>) | undefined;
    readonly platform: "android" | "ios";
    readonly io: CommandIO;
  },
): Promise<UiScreen[]> {
  const { masker, events } = session;
  const webFactory =
    ports.snapshotBrowser ??
    (ports.executor
      ? undefined
      : snapshotBrowser(session, env, ports, await httpCredentialsFor(env, session.resolveSecret)));
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
              login: snapshotLogin(session, env, ports, scratch),
              aliases: Object.keys(env.profile.accounts),
              knownPages: options.knownPages,
              baseUrl: env.baseUrl,
              allowedOrigins: [env.origin],
            },
          }
        : {}),
      ...(device?.ok && device.factories[0]
        ? { mobile: { factory: device.factories[0], platform: options.platform } }
        : {}),
      mask: (v) => masker.maskJson(v),
      emit: (event, details) => {
        events.emit("author", { kind: "system", name: "orchestrator" }, event, details);
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
    // Pages recorded before planning that this run did not record again (AC7).
    const recorded = new Set(screens.map((s) => `${s.platform} ${s.where}`));
    const planned = ((await readPlanSnapshot(session.ws)) ?? []).filter(
      (s) => !recorded.has(`${s.platform} ${s.where}`),
    );
    return [...screens, ...planned];
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
