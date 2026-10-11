import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import type { RuntimePorts } from "../adapters.js";
import type { RunSession } from "../session.js";
import type { CommandIO } from "./fetch.js";
import { accountLogin } from "./lanes.js";
import type { PreparedMobile } from "./mobile.js";
import { crawlUiSnapshot, recordUiSnapshot, type UiSnapshotInput } from "./ui-snapshot.js";

/** Ports of the snapshot: a browser replaced in tests (default: headless Playwright). */
export interface SnapshotPorts {
  readonly snapshotBrowser?: BrowserFactory;
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
 * (only a tests repository or none), or when asked with `--snapshot`. An earlier recording of the run is reused unless
 * asked again. Without a reachable environment the planner works without it and the person is told (AC6).
 *
 * @returns The recorded pages, or undefined.
 */
export async function planSnapshot(
  session: RunSession,
  io: CommandIO,
  ports: RuntimePorts & SnapshotPorts,
  options: { readonly env?: string | undefined; readonly force: boolean },
): Promise<UiScreen[] | undefined> {
  const { ws, project, masker, events } = session;
  const saved = await readPlanSnapshot(ws);
  if (saved && !options.force) return saved;
  const hasCode = Object.values(ws.record.repos).some((r) => r.role !== "tests");
  if (hasCode && !options.force) return undefined;
  let env: ResolvedEnvironment;
  try {
    env = await resolveEnvironment({ config: project.config, qaDir: project.qaDir, env: options.env });
  } catch (error) {
    io.writeError(
      `No environment to record pages from (${error instanceof Error ? error.message : String(error)}); planning without them.\n`,
    );
    return undefined;
  }
  const reached = await createRemoteEnvProvider(env, ports.fetch, { readVersion: false }).start();
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
      factory: snapshotBrowser(session, env, ports),
      login: snapshotLogin(session, env, ports, scratch),
      account,
      baseUrl: env.baseUrl,
      allowedOrigins: [env.origin],
      mask: (v) => masker.maskJson(v),
      emit: (event, details) => {
        events.emit("plan", { kind: "system", name: "orchestrator" }, event, details);
        if (event === "ui.snapshot.failed")
          io.writeError(`Could not record ${String(details["where"])}: ${String(details["error"])}\n`);
      },
    });
    await mkdir(ws.path("ui"), { recursive: true });
    await writeFile(ws.path(...FILE), `${JSON.stringify(screens, null, 2)}\n`, "utf8");
    io.write(`Recorded ${String(screens.length)} page(s) of ${env.name} for the planner.\n`);
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
    ports.snapshotBrowser ?? (ports.executor ? undefined : snapshotBrowser(session, env, ports));
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
