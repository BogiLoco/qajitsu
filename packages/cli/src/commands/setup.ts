import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, platform, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createEnvSecretProvider } from "@qajitsu/adapter-secrets-env";
import { startAndroidEmulator } from "@qajitsu/adapter-runner-mobile";
import { ConfigError, qajitsuHome } from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import {
  isToolId,
  loadToolchainConfig,
  planToolchain,
  runSetup,
  runSetupFromBundle,
  setupExitCode,
  sourceUrls,
  toolchainNeeds,
  toolchainRoot,
  uninstallTools,
  userEnv,
  type ExplicitTools,
  type Host,
  type PlanStep,
  type RunExec,
  type SetupOptions,
  type SetupPorts,
  type SetupReport,
  type ToolchainFile,
  type ToolchainNeeds,
  type ToolId,
  TOOL_IDS,
} from "@qajitsu/toolchain";
import { createCliSecretResolver, type RuntimePorts } from "../adapters.js";
import type { LoadedProject } from "../project.js";
import { execVersion, playwrightInfo } from "../versions.js";
import type { CommandIO } from "./fetch.js";

/** Flags of `qj setup` (REQ-GEN-06). */
export interface SetupCommandOptions {
  readonly check?: boolean;
  readonly json?: boolean;
  readonly only?: readonly string[];
  readonly skip?: readonly string[];
  readonly yes?: boolean;
  readonly reinstall?: readonly string[];
  readonly uninstall?: string | boolean;
  readonly all?: boolean;
  readonly version?: readonly string[];
  readonly download?: string;
  readonly from?: string;
  readonly smoke?: boolean;
}

const MB = 1024 * 1024;

/** `--only java,android --only appium` → tools; an unknown name is an error, never ignored. */
export function toolList(values: readonly string[] | undefined, flag: string): ToolId[] {
  const names = (values ?? [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  const unknown = names.filter((n) => !isToolId(n));
  if (unknown.length > 0)
    throw new ConfigError(
      "TOOL_UNKNOWN",
      `${flag}: unknown tool ${unknown.join(", ")}; tools are ${TOOL_IDS.join(", ")}`,
      {},
    );
  return [...new Set(names)] as ToolId[];
}

/** `--version java=21` → `{ java: "21" }`. */
export function versionFlags(values: readonly string[] | undefined): Partial<Record<ToolId, string>> {
  const out: Partial<Record<ToolId, string>> = {};
  for (const v of values ?? []) {
    const [tool = "", version = ""] = v.split("=", 2);
    if (!isToolId(tool) || !/^\d+(\.\d+)*(\+\d+)?$/.test(version))
      throw new ConfigError(
        "TOOL_VERSION_INVALID",
        `--version ${v}: expected <tool>=<version>, e.g. java=21`,
        {},
      );
    out[tool] = version;
  }
  return out;
}

/** The machine as QAJitsu sees it: macOS or Linux on arm64 or x86_64. */
export function hostOf(os: string = platform(), cpu: string = arch()): Host {
  if ((os !== "darwin" && os !== "linux") || (cpu !== "arm64" && cpu !== "x64"))
    throw new ConfigError(
      "TOOLCHAIN_HOST_UNSUPPORTED",
      `qj setup supports macOS and Linux on arm64 and x86_64; this is ${os} ${cpu}. Install the tools yourself (qj doctor lists them).`,
      {},
    );
  return { os, arch: cpu };
}

/** Commands run by setup: argument arrays, never a shell; `interactive` hands over the terminal. */
export const runTool: RunExec = (cmd, args, options = {}) =>
  new Promise((done) => {
    const child = spawn(cmd, [...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: { ...process.env, ...options.env },
      stdio: options.interactive === true ? "inherit" : ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    // Only the tail matters for messages; sdkmanager can print a lot.
    const keep = (text: string, chunk: string): string => (text + chunk).slice(-4 * MB);
    child.stdout?.on("data", (d: Buffer) => {
      stdout = keep(stdout, d.toString());
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr = keep(stderr, d.toString());
    });
    if (options.interactive !== true) child.stdin?.end(options.input ?? "");
    child.on("error", (error) => {
      done({ code: 127, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      done({ code: code ?? 1, stdout, stderr });
    });
  });

async function freeBytes(path: string): Promise<number | undefined> {
  for (let p = path; ; p = dirname(p)) {
    if (existsSync(p)) {
      const s = await statfs(p).catch(() => undefined);
      return s ? s.bavail * s.bsize : undefined;
    }
    if (dirname(p) === p) return undefined;
  }
}

/** The real ports of setup, with the parts tests replace from `ports.toolchain`. */
export function setupPorts(
  ports: RuntimePorts,
  io: CommandIO,
  root: string,
  project: LoadedProject | undefined,
  log: (line: string) => void,
): SetupPorts {
  const require = createRequire(import.meta.url);
  const pwDir = (() => {
    try {
      return dirname(require.resolve("playwright-core"));
    } catch {
      return "";
    }
  })();
  const host = ports.toolchain?.host ?? hostOf();
  const pw = (ports.playwright ?? playwrightInfo)();
  const masker = createMasker();
  const env = createEnvSecretProvider({ env: ports.env });
  const ask = io.ask;
  return {
    exec: ports.versionExec ?? execVersion,
    exists: existsSync,
    env: userEnv(ports.env, root),
    home: ports.home,
    host,
    browsers: () => pw.browsers,
    freeBytes,
    totalMemory: totalmem(),
    kvmAccessible: () => {
      try {
        accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    run: runTool,
    ask: ask
      ? async (question: string) => /^y(es)?$/i.test((await ask(`${question} [y/N] `)).trim())
      : undefined,
    log,
    now: ports.now,
    node: process.execPath,
    playwrightCli: join(pwDir, "cli.js"),
    playwrightVersion: pw.version ?? "unknown",
    browserCache:
      ports.env["PLAYWRIGHT_BROWSERS_PATH"] ??
      (host.os === "darwin"
        ? join(ports.home, "Library", "Caches", "ms-playwright")
        : join(ports.home, ".cache", "ms-playwright")),
    smoke: {
      launchBrowser: async (name) => {
        try {
          const playwright = (await import("playwright-core")) as unknown as Record<
            string,
            { launch(o: { headless: boolean }): Promise<{ close(): Promise<void> }> } | undefined
          >;
          const browser = await playwright[name]?.launch({ headless: true });
          if (!browser) return `${name} is not a Playwright browser`;
          await browser.close();
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message.split("\n")[0] : String(error);
        }
      },
      bootEmulator: async (sdk, avd, systemImage, toolEnv) => {
        try {
          const emulator = await startAndroidEmulator({
            sdkRoot: sdk,
            avd,
            systemImage,
            headless: true,
            bootTimeoutMs: 300_000,
            ...(toolEnv["ANDROID_AVD_HOME"] ? { avdHome: toolEnv["ANDROID_AVD_HOME"] } : {}),
          });
          await emulator.stop();
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    },
    resolveSecret: project
      ? createCliSecretResolver(project, ports, masker)
      : (ref: string) => env.resolve(ref),
    ...ports.toolchain,
  };
}

/** Paths the project configures for Android and Appium; they come before anything else. */
export function explicitTools(project: LoadedProject | undefined): ExplicitTools {
  const mobile = project?.config.mobile;
  const rel = (p: string | undefined) =>
    p === undefined ? undefined : p.includes("/") ? resolve(project?.qaDir ?? ".", p) : p;
  return {
    androidSdkRoot: mobile?.android?.sdk_root,
    appiumBin: rel(mobile?.appium.bin),
    appiumHome: mobile?.appium.home ? resolve(project?.qaDir ?? ".", mobile.appium.home) : undefined,
  };
}

const NO_NEEDS: ToolchainNeeds = { tools: new Map(), browsers: [] };

const SYMBOL: Record<PlanStep["action"], string> = {
  "use-system": "✔",
  "use-managed": "✔",
  install: "↓",
  reinstall: "↓",
  start: "▶",
  skip: "·",
  manual: "!",
  unsupported: "✘",
};

const size = (bytes: number): string =>
  bytes >= 1024 * MB ? `${(bytes / (1024 * MB)).toFixed(1)} GB` : `${String(Math.round(bytes / MB))} MB`;

/** One line of the plan. */
export function formatStep(s: PlanStep): string {
  const what =
    s.action === "use-system"
      ? `use yours ${s.version}`
      : s.action === "use-managed"
        ? `use QAJitsu's ${s.version}`
        : s.action === "skip"
          ? "skip"
          : s.action === "install" || s.action === "reinstall"
            ? `${s.action} ${s.version}${s.parts.length > 0 && s.tool !== "uiautomator2" && s.tool !== "xcuitest" ? ` (${s.parts.join(", ")})` : ""}${s.bytes > 0 ? `, ${size(s.bytes)}` : ""} from ${s.source}`
            : s.action;
  return `  ${SYMBOL[s.action]} ${s.tool.padEnd(12)} ${what}: ${s.reason}`;
}

/** The terminal report of a setup (REQ-GEN-06/AC4+AC8). */
export function formatSetupReport(report: SetupReport, root: string): string {
  const lines = [
    `Toolchain plan (${root}):`,
    ...report.steps.map(formatStep),
    "Prechecks:",
    ...report.prechecks.map((p) => `  ${p.ok ? "✔" : "✘"} ${p.name}: ${p.detail}`),
  ];
  if (report.stopped !== undefined) lines.push(`Stopped: ${report.stopped}`);
  if (report.licences.length > 0) lines.push("Licences accepted:", ...report.licences.map((l) => `  - ${l}`));
  if (report.results.length > 0)
    lines.push(
      "Result:",
      ...report.results.map(
        (r) =>
          `  ${r.status === "ready" ? "✔" : r.status === "skipped" ? "·" : r.status === "manual" ? "!" : "✘"} ${r.tool.padEnd(12)} ${r.status}: ${r.detail}${r.next ? `; next: ${r.next}` : ""}`,
      ),
    );
  return lines.join("\n");
}

async function context(
  ports: RuntimePorts,
  project: LoadedProject | undefined,
): Promise<{ root: string; config: ToolchainFile; needs: ToolchainNeeds; projectHome?: string }> {
  const home = qajitsuHome(ports.env, ports.home);
  const config = await loadToolchainConfig(home, project?.qaDir);
  return {
    root: toolchainRoot(home),
    config,
    needs: project ? toolchainNeeds(project.config, config.versions) : NO_NEEDS,
    ...(ports.project ? { projectHome: ports.project.paths.home } : {}),
  };
}

/**
 * `qj setup` (REQ-GEN-06): installs what the project needs, or with `--check` prints the plan; `--uninstall`
 * removes what QAJitsu installed; `--download` / `--from` make and use an offline bundle.
 *
 * @returns 0 everything is ready, 1 a tool failed or needs a manual step, 2 setup stopped or a flag is wrong.
 */
export async function runSetupCommand(
  options: SetupCommandOptions,
  io: CommandIO,
  ports: RuntimePorts,
  project: LoadedProject | undefined,
): Promise<number> {
  try {
    const ctx = await context(ports, project);
    const log = (line: string) => {
      (options.json === true ? io.writeError : io.write)(`${line}\n`);
    };
    if (options.uninstall !== undefined && options.uninstall !== false) {
      const tools =
        options.all === true
          ? ("all" as const)
          : toolList(typeof options.uninstall === "string" ? [options.uninstall] : [], "--uninstall");
      if (tools !== "all" && tools.length === 0)
        throw new ConfigError(
          "TOOL_UNKNOWN",
          "--uninstall needs a tool (e.g. --uninstall java) or --all",
          {},
        );
      const sp = setupPorts(ports, io, ctx.root, project, log);
      const report = await uninstallTools(ctx.root, tools, {
        run: sp.run,
        node: sp.node,
        playwrightCli: sp.playwrightCli,
        log,
      });
      if (options.json === true) io.write(`${JSON.stringify(report, null, 2)}\n`);
      else
        io.write(
          [
            ...report.removed.map((e) => `✔ removed ${e.tool} ${e.version}`),
            ...report.kept.map((k) => `· kept ${k.entry.tool} ${k.entry.version}: ${k.reason}`),
            ...report.notInstalled.map((t) => `· ${t}: QAJitsu did not install it; nothing changed`),
          ].join("\n") + "\n",
        );
      return report.kept.some((k) => !k.entry.system) ? 1 : 0;
    }
    if (project === undefined && (options.only ?? []).length === 0 && options.from === undefined)
      io.writeError(
        "No project: nothing is needed. Name the tools with --only (e.g. --only java,android), or run qj setup in a project.\n",
      );
    const setupOptions: SetupOptions = {
      only: toolList(options.only, "--only"),
      skip: toolList(options.skip, "--skip"),
      reinstall: toolList(options.reinstall, "--reinstall"),
      versions: versionFlags(options.version),
      ...(options.check === true ? { check: true } : {}),
      ...(options.yes === true ? { yes: true } : {}),
      ...(options.smoke === true ? { smoke: true } : {}),
    };
    if (options.download !== undefined && options.from !== undefined)
      throw new ConfigError("SETUP_FLAGS", "--download and --from cannot be used together", {});
    const bundle = options.download !== undefined ? resolve(io.cwd, options.download) : undefined;
    const root = bundle !== undefined ? join(bundle, "toolchain") : ctx.root;
    const input = {
      root,
      needs: ctx.needs,
      config: ctx.config,
      explicit: explicitTools(project),
      ...(bundle === undefined && ctx.projectHome ? { projectHome: ctx.projectHome } : {}),
      options: setupOptions,
      ports: setupPorts(ports, io, ctx.root, project, log),
      ...(bundle !== undefined ? { bundle } : {}),
    };
    const report =
      options.from !== undefined
        ? await runSetupFromBundle(input, resolve(io.cwd, options.from))
        : await runSetup(input);
    io.write(
      options.json === true
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${formatSetupReport(report, root)}\n${bundle !== undefined && report.stopped === undefined ? `Bundle: ${bundle} (copy it to the offline machine, then: qj setup --from <dir>)\n` : ""}`,
    );
    return options.check === true ? (report.prechecks.every((p) => p.ok) ? 0 : 2) : setupExitCode(report);
  } catch (error) {
    io.writeError(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

/**
 * The toolchain lines of `qj doctor` (REQ-GEN-06/AC2+AC9): what setup would do for each needed tool. A tool of the
 * user's that is not compatible is information (the user decides), with the range and the fix.
 */
export async function toolchainDoctor(
  ports: RuntimePorts,
  io: CommandIO,
  project: LoadedProject,
): Promise<{ lines: string[]; missing: ToolId[] }> {
  const ctx = await context(ports, project);
  const { steps } = await planToolchain({
    root: ctx.root,
    needs: ctx.needs,
    config: ctx.config,
    explicit: explicitTools(project),
    options: {},
    ports: setupPorts(ports, io, ctx.root, project, () => undefined),
  });
  const wanted = steps.filter((s) => s.action !== "skip");
  return {
    lines: wanted.map((s) =>
      s.action === "install" && s.reason.startsWith("yours")
        ? `  ! ${s.tool.padEnd(12)} ${s.reason.replace("QAJitsu installs", "qj setup installs")}`
        : formatStep(s),
    ),
    missing: wanted.filter((s) => s.action === "install" || s.action === "start").map((s) => s.tool),
  };
}

/** Doctor's `--online` check of the configured sources (REQ-GEN-06/AC7). */
export async function checkSources(
  ports: RuntimePorts,
  project: LoadedProject | undefined,
): Promise<{ name: string; ok: boolean; detail: string }[]> {
  const ctx = await context(ports, project);
  return Promise.all(
    sourceUrls(ctx.config).map(async (s) => {
      const status = await ports
        .fetch(s.url, { method: "HEAD", signal: AbortSignal.timeout(10_000) })
        .then((r) => r.status)
        .catch(() => undefined);
      return {
        name: `source ${s.name}`,
        ok: status !== undefined && status < 500,
        detail: status === undefined ? `${s.url} does not answer` : `${s.url} answers (${String(status)})`,
      };
    }),
  );
}
