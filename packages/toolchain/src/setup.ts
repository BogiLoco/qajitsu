import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ToolchainFile } from "./config.js";
import { detectToolchain, type DetectPorts, type DetectedTool, type ExplicitTools } from "./detect.js";
import {
  appiumBinOf,
  installAndroid,
  installAppium,
  installBrowsers,
  installDocker,
  installDriver,
  installJava,
  installXcode,
  ManualStepError,
  startDocker,
  type InstallContext,
} from "./installers.js";
import { acquireSetupLock } from "./lock.js";
import { MANIFEST, TOOL_IDS, type ToolId } from "./manifest.js";
import type { ToolchainNeeds } from "./needs.js";
import { networkFor, writeCaBundle, writeNpmrc, type RunExec } from "./network.js";
import { changingSteps, planSetup, type PlanOptions, type PlanStep } from "./plan.js";
import { runPrechecks, type Precheck, type PrecheckPorts } from "./prechecks.js";
import {
  choiceFile,
  readToolchainChoice,
  readToolchainRecord,
  recordInstalled,
  writeJsonAtomic,
  type InstalledTool,
  type ToolchainChoice,
} from "./registry.js";
import { importBundle, writeBundleManifest } from "./offline.js";
import { smokeTest, type SmokePorts } from "./smoke.js";
import { isInside } from "./uninstall.js";

/** Outcome of setup for one tool. `ready` is reported only after the tool was found compatible or passed its smoke test. */
export interface ToolResult {
  readonly tool: ToolId;
  readonly status: "ready" | "failed" | "manual" | "skipped";
  readonly detail: string;
  readonly next?: string | undefined;
}

/** Ports of {@link runSetup}. */
export interface SetupPorts extends DetectPorts, PrecheckPorts {
  readonly run: RunExec;
  /** Asks a yes/no question; undefined when no terminal is attached. */
  readonly ask?: ((question: string) => Promise<boolean>) | undefined;
  readonly log: (line: string) => void;
  readonly now: () => Date;
  readonly node: string;
  readonly playwrightCli: string;
  readonly playwrightVersion: string;
  /** Playwright's browser cache. */
  readonly browserCache: string;
  readonly smoke: SmokePorts;
  /** The pinned archives (replaced in tests). */
  readonly artifacts?: InstallContext["artifacts"];
  /** Resolves `secret://` references (the npm token). */
  readonly resolveSecret?: ((ref: string) => Promise<string>) | undefined;
}

/** Choices of `qj setup` (REQ-GEN-06/AC4..AC8). */
export interface SetupOptions extends PlanOptions {
  /** Print the plan only. */
  readonly check?: boolean;
  /** No questions: licences are accepted on the user's behalf and listed. */
  readonly yes?: boolean;
  /** Also boot the emulator once. */
  readonly smoke?: boolean;
  /**
   * Prechecks that do not stop setup, by name (e.g. `virtualisation` when building an image on a machine without KVM
   * for hosts that have it). They are still reported, marked as ignored.
   */
  readonly ignoreChecks?: readonly string[];
}

/** Inputs of {@link runSetup}. */
export interface SetupInput {
  readonly root: string;
  readonly needs: ToolchainNeeds;
  readonly config: ToolchainFile;
  readonly explicit?: ExplicitTools;
  /** The project's home: its toolchain choice is written there. */
  readonly projectHome?: string | undefined;
  readonly options: SetupOptions;
  readonly ports: SetupPorts;
  /**
   * `--download <dir>`: install every managed tool the project needs into `<dir>/toolchain` and the browsers into
   * `<dir>/ms-playwright`, whatever this machine already has, for `qj setup --from <dir>` on an offline machine.
   */
  readonly bundle?: string | undefined;
}

/** What setup did or would do. */
export interface SetupReport {
  readonly steps: readonly PlanStep[];
  readonly prechecks: readonly Precheck[];
  readonly results: readonly ToolResult[];
  /** Licences accepted on the user's behalf (`--yes`), or confirmed by the user. */
  readonly licences: readonly string[];
  /** Why setup stopped before changing anything. */
  readonly stopped?: string | undefined;
}

const MB = 1024 * 1024;
const STARTED = { path: "", source: "start", licence: "-", verified: false, system: true } as const;
const ORDER: readonly ToolId[] = [
  "java",
  "android",
  "appium",
  "uiautomator2",
  "xcuitest",
  "browsers",
  "docker",
  "xcode",
];

/** Detection for a bundle: nothing outside the bundle counts, so every managed tool is installed into it. */
const emptyMachine = (ports: SetupPorts, root: string): SetupPorts => ({
  ...ports,
  exec: () => Promise.resolve(undefined),
  exists: (path) => isInside(path, root) && ports.exists(path),
  browsers: () => ["chromium", "firefox", "webkit"].map((name) => ({ name, installed: false })),
});

/** A bundle holds managed tools only; Docker and Xcode are installed on the offline machine, AVDs are made there. */
const forBundle = (s: PlanStep): PlanStep =>
  s.action === "skip"
    ? s
    : s.tool === "docker" || s.tool === "xcode"
      ? {
          ...s,
          action: "manual",
          reason: "system-wide: install it on the offline machine (qj setup --only " + s.tool + ")",
        }
      : s.tool === "android"
        ? { ...s, parts: s.parts.filter((p) => !p.startsWith("avd:")) }
        : s;

/** Plans setup without changing anything: detection, plan and prechecks (`qj setup --check`, `qj doctor`). */
export async function planToolchain(
  input: Omit<SetupInput, "options"> & {
    readonly options: PlanOptions & { readonly ignoreChecks?: readonly string[] };
  },
): Promise<{ detected: DetectedTool[]; steps: PlanStep[]; prechecks: Precheck[] }> {
  const record = await readToolchainRecord(input.root);
  const ports = input.bundle !== undefined ? emptyMachine(input.ports, input.root) : input.ports;
  const only = input.options.only ?? [];
  const wanted = new Set<ToolId>(only.length > 0 ? only : [...input.needs.tools.keys()]);
  // Drivers are planned together with Appium, and Android needs Java.
  if (wanted.has("uiautomator2") || wanted.has("xcuitest")) wanted.add("appium");
  if (wanted.has("android")) wanted.add("java");
  const detected = await detectToolchain(input.needs, record, ports, input.explicit, wanted);
  const planned = planSetup({
    needs: input.needs,
    detected,
    host: input.ports.host,
    root: input.root,
    config: input.config,
    options: input.options,
    artifacts: input.ports.artifacts,
    playwrightVersion: input.ports.playwrightVersion,
  });
  const steps = input.bundle !== undefined ? planned.map(forBundle) : planned;
  const ignored = new Set(input.options.ignoreChecks ?? []);
  const prechecks = (await runPrechecks(steps, input.needs, input.ports, input.root)).map((p) =>
    !p.ok && ignored.has(p.name) ? { ...p, detail: `${p.detail} (ignored: --ignore-check ${p.name})` } : p,
  );
  return { detected, steps, prechecks };
}

async function confirm(
  input: SetupInput,
  changing: readonly PlanStep[],
): Promise<{ stopped?: string; declined: Set<ToolId>; licences: string[] }> {
  const licences = [...new Set(changing.map((s) => `${s.tool}: ${s.licence}`))];
  const declined = new Set<ToolId>();
  if (input.options.yes === true) return { declined, licences };
  const ask = input.ports.ask;
  if (ask === undefined)
    return {
      stopped:
        "setup needs your confirmation for licences and large downloads: run it in a terminal, or with --yes",
      declined,
      licences,
    };
  if (
    !(await ask(
      `These licences apply:\n${licences.map((l) => `  - ${l}`).join("\n")}\nAccept them and continue?`,
    ))
  )
    return { stopped: "licences not accepted; nothing was changed", declined, licences };
  for (const s of changing)
    if (
      s.bytes > 100 * MB &&
      !(await ask(`Download about ${String(Math.round(s.bytes / MB))} MB for ${s.tool} from ${s.source}?`))
    )
      declined.add(s.tool);
  return { declined, licences };
}

async function networkContext(input: SetupInput): Promise<ReturnType<typeof networkFor>> {
  const { config, root } = input;
  const caBundle =
    config.network.ca_certs !== undefined ? await writeCaBundle(config.network.ca_certs, root) : undefined;
  const token =
    config.sources.npm_token !== undefined && input.ports.resolveSecret
      ? await input.ports.resolveSecret(config.sources.npm_token)
      : undefined;
  const npmrc =
    token !== undefined && config.sources.npm_registry !== undefined
      ? await writeNpmrc(config.sources.npm_registry, root)
      : undefined;
  return networkFor(config, {
    ...(caBundle ? { caBundle } : {}),
    ...(npmrc ? { npmrc } : {}),
    ...(token !== undefined ? { npmToken: token } : {}),
  });
}

/** The Java, Appium and drivers home the installers of later tools use, from the earlier tools' outcome. */
function chosenPaths(
  steps: readonly PlanStep[],
  detected: readonly DetectedTool[],
  installed: ReadonlyMap<ToolId, InstalledTool>,
  explicit: ExplicitTools,
  env: DetectPorts["env"],
): { javaHome?: string; javaReady: boolean; appiumBin?: string } {
  const java = steps.find((s) => s.tool === "java");
  const own = detected.find((d) => d.tool === "java");
  const managedJava =
    installed.get("java")?.path ??
    (java?.action === "use-managed" ? java.path : undefined) ??
    own?.managed[0]?.path;
  const systemJava = own?.system?.compatible === true;
  const javaHome =
    managedJava ?? (systemJava && own.system.where === "$JAVA_HOME" ? env["JAVA_HOME"] : undefined);
  const appium = steps.find((s) => s.tool === "appium");
  const ownAppium = detected.find((d) => d.tool === "appium");
  const managedAppium =
    installed.get("appium")?.path ??
    (appium?.action === "use-managed" ? appium.path : undefined) ??
    ownAppium?.managed[0]?.path;
  const appiumBin =
    managedAppium !== undefined
      ? appiumBinOf(managedAppium)
      : ownAppium?.system !== undefined
        ? (explicit.appiumBin ?? "appium")
        : undefined;
  return {
    ...(javaHome !== undefined ? { javaHome } : {}),
    javaReady: managedJava !== undefined || systemJava,
    ...(appiumBin !== undefined ? { appiumBin } : {}),
  };
}

async function installOne(
  ctx: InstallContext,
  s: PlanStep,
  record: readonly InstalledTool[],
  input: SetupInput,
): Promise<InstalledTool | undefined> {
  switch (s.tool) {
    case "java":
      return installJava(ctx, s);
    case "android":
      return installAndroid(
        ctx,
        s,
        s.action === "reinstall" ? undefined : record.find((r) => r.tool === "android"),
      );
    case "appium":
      return installAppium(ctx, s);
    case "uiautomator2":
    case "xcuitest":
      return installDriver(ctx, { ...s, tool: s.tool });
    case "browsers":
      return installBrowsers(ctx, s, input.ports.browserCache, input.ports.playwrightVersion);
    case "docker":
      if (s.action === "start") {
        await startDocker(ctx);
        return undefined;
      }
      return installDocker(ctx);
    case "xcode":
      return installXcode(ctx, s);
  }
}

const describe = (s: PlanStep): string =>
  s.action === "use-system"
    ? `yours, ${s.version} (${s.reason})`
    : s.action === "use-managed"
      ? `QAJitsu's ${s.version} (${s.path ?? ""})`
      : s.reason;

async function writeChoice(
  input: SetupInput,
  steps: readonly PlanStep[],
  installed: ReadonlyMap<ToolId, InstalledTool>,
  results: readonly ToolResult[],
): Promise<void> {
  if (input.projectHome === undefined) return;
  const previous = await readToolchainChoice(input.projectHome);
  const tools: ToolchainChoice["tools"] = { ...previous?.tools };
  for (const r of results) {
    if (r.status !== "ready") continue;
    const s = steps.find((x) => x.tool === r.tool);
    const entry = installed.get(r.tool);
    if (entry)
      tools[r.tool] = { use: entry.system ? "system" : "managed", version: entry.version, path: entry.path };
    else if (s?.action === "use-managed")
      tools[r.tool] = { use: "managed", version: s.version, ...(s.path ? { path: s.path } : {}) };
    else if (s) tools[r.tool] = { use: "system", version: s.version, ...(s.path ? { path: s.path } : {}) };
  }
  await mkdir(input.projectHome, { recursive: true });
  await writeJsonAtomic(choiceFile(input.projectHome), {
    schema: 1,
    updated_at: input.ports.now().toISOString(),
    tools,
  } satisfies ToolchainChoice);
}

/** The install context of a setup. */
function contextFor(
  input: SetupInput,
  network: ReturnType<typeof networkFor>,
  acceptedLicences: string[],
  paths: { javaHome?: string; javaReady: boolean; appiumBin?: string },
): InstallContext {
  return {
    root: input.root,
    host: input.ports.host,
    config: input.config,
    exec: input.ports.run,
    network:
      input.bundle !== undefined
        ? {
            ...network,
            env: { ...network.env, PLAYWRIGHT_BROWSERS_PATH: join(input.bundle, "ms-playwright") },
          }
        : network,
    yes: input.options.yes === true,
    interactive: input.ports.ask !== undefined,
    now: input.ports.now,
    home: input.ports.home,
    node: input.ports.node,
    playwrightCli: input.ports.playwrightCli,
    acceptedLicences,
    log: input.ports.log,
    ...(input.ports.artifacts ? { artifacts: input.ports.artifacts } : {}),
    ...paths,
  };
}

/**
 * `qj setup` (REQ-GEN-06): plans what the project needs, runs the prechecks, asks for the licences and every download
 * over 100 MB (unless `--yes`), takes the lock, installs, smoke-tests every installed tool, records it and writes the
 * project's choice of tools. Nothing is reported ready that was not found compatible or did not pass its smoke test;
 * a tool that fails is reported with the next step and the others continue.
 */
export async function runSetup(input: SetupInput): Promise<SetupReport> {
  const { steps, prechecks, detected } = await planToolchain(input);
  const changing = changingSteps(steps);
  if (input.options.check === true) return { steps, prechecks, results: [], licences: [] };
  const ignored = new Set(input.options.ignoreChecks ?? []);
  const blocking = prechecks.filter(
    (p) => !p.ok && !ignored.has(p.name) && p.tools.some((t) => changing.some((s) => s.tool === t)),
  );
  if (blocking.length > 0)
    return {
      steps,
      prechecks,
      results: [],
      licences: [],
      stopped: `stopped before downloading anything: ${blocking.map((p) => `${p.name}: ${p.detail}`).join("; ")}`,
    };
  const confirmation =
    changing.length > 0 ? await confirm(input, changing) : { declined: new Set<ToolId>(), licences: [] };
  if (confirmation.stopped !== undefined)
    return { steps, prechecks, results: [], licences: [], stopped: confirmation.stopped };
  const lock = changing.length > 0 ? await acquireSetupLock(input.root) : undefined;
  const results: ToolResult[] = [];
  const installed = new Map<ToolId, InstalledTool>();
  const acceptedLicences: string[] = [];
  try {
    const network = changing.length > 0 ? await networkContext(input) : networkFor(input.config);
    const record = (await readToolchainRecord(input.root)).tools;
    for (const tool of ORDER) {
      const s = steps.find((x) => x.tool === tool);
      if (!s || s.action === "skip") continue;
      if (s.action === "use-system" || s.action === "use-managed") {
        results.push({ tool, status: "ready", detail: describe(s) });
        continue;
      }
      if (s.action === "manual" || s.action === "unsupported") {
        results.push({ tool, status: s.action === "manual" ? "manual" : "failed", detail: s.reason });
        continue;
      }
      if (confirmation.declined.has(tool)) {
        results.push({
          tool,
          status: "skipped",
          detail: "download not confirmed",
          next: `qj setup --only ${tool}`,
        });
        continue;
      }
      const ctx = contextFor(
        input,
        network,
        acceptedLicences,
        chosenPaths(steps, detected, installed, input.explicit ?? {}, input.ports.env),
      );
      try {
        const entry = await installOne(ctx, s, record, input);
        // Starting Docker installs nothing; its smoke test checks the daemon it started.
        const tested: InstalledTool = entry ?? {
          ...STARTED,
          tool,
          version: s.version,
          parts: [],
          installed_at: input.ports.now().toISOString(),
        };
        const smoke =
          input.bundle !== undefined && tool === "browsers"
            ? {
                tool,
                ok: true,
                detail: `${s.parts.join(", ")} in the bundle; they are start-tested when installed from it`,
              }
            : await smokeTest(ctx, tested, {
                android: input.needs.android,
                boot: input.options.smoke === true,
                noAccel: ignored.has("virtualisation"),
                ports: input.ports.smoke,
              });
        if (entry) {
          const verified = { ...entry, verified: smoke.ok };
          await recordInstalled(input.root, verified);
          if (smoke.ok) installed.set(tool, verified);
        }
        results.push({ tool, status: smoke.ok ? "ready" : "failed", detail: smoke.detail, next: smoke.next });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push(
          error instanceof ManualStepError
            ? { tool, status: "manual", detail: message }
            : { tool, status: "failed", detail: message, next: `qj setup --only ${tool}` },
        );
      }
    }
    if (input.bundle !== undefined)
      await writeBundleManifest(input.bundle, input.ports.host, input.ports.now);
    else await writeChoice(input, steps, installed, results);
  } finally {
    await lock?.release();
  }
  return { steps, prechecks, results, licences: [...confirmation.licences, ...acceptedLicences] };
}

/** Exit code of a setup: 0 everything wanted is ready, 1 a tool failed or needs a manual step, 2 setup stopped. */
export function setupExitCode(report: SetupReport): number {
  if (report.stopped !== undefined) return 2;
  return report.results.every((r) => r.status === "ready") ? 0 : 1;
}

/** Every tool id, for `--only` and `--skip` validation. */
export const SETUP_TOOLS = TOOL_IDS;

/**
 * `qj setup --from <dir>` (REQ-GEN-06/AC7): copies the tools of an offline bundle into the toolchain after checking
 * its digests, smoke-tests and records each of them, then runs setup for the rest (AVDs, Docker, Xcode) without
 * downloading what the bundle brought.
 */
export async function runSetupFromBundle(input: SetupInput, dir: string): Promise<SetupReport> {
  const lock = await acquireSetupLock(input.root);
  const results: ToolResult[] = [];
  try {
    const imported = await importBundle(
      dir,
      input.root,
      input.ports.host,
      input.ports.browserCache,
      input.ports.now,
    );
    const appium = imported.tools.find((t) => t.tool === "appium");
    const java = imported.tools.find((t) => t.tool === "java");
    const ctx = contextFor(input, networkFor(input.config), [], {
      ...(java ? { javaHome: java.path } : {}),
      javaReady: java !== undefined,
      ...(appium ? { appiumBin: appiumBinOf(appium.path) } : {}),
    });
    const browsers = [
      ...new Set(
        imported.browsers
          .map((b) => b.split("-")[0] ?? "")
          .filter((b) => b === "chromium" || b === "firefox" || b === "webkit"),
      ),
    ];
    const entries: InstalledTool[] = [
      ...imported.tools,
      ...(browsers.length > 0
        ? [
            {
              tool: "browsers" as const,
              version: input.ports.playwrightVersion,
              path: input.ports.browserCache,
              source: `bundle:${dir}`,
              licence: MANIFEST.browsers.licence,
              installed_at: input.ports.now().toISOString(),
              parts: browsers,
              verified: false,
              system: false,
            },
          ]
        : []),
    ];
    for (const entry of entries) {
      const smoke = await smokeTest(ctx, entry, {
        android: undefined,
        boot: false,
        ports: input.ports.smoke,
      });
      await recordInstalled(input.root, { ...entry, verified: smoke.ok });
      if (!smoke.ok)
        results.push({ tool: entry.tool, status: "failed", detail: smoke.detail, next: smoke.next });
    }
  } finally {
    await lock.release();
  }
  const rest = await runSetup(input);
  return {
    ...rest,
    results: [...results, ...rest.results.filter((r) => !results.some((f) => f.tool === r.tool))],
  };
}
