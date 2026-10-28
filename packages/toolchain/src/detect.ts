import { join } from "node:path";
import { MANIFEST, TOOL_IDS, type Host, type ToolId } from "./manifest.js";
import type { ToolchainNeeds } from "./needs.js";
import type { InstalledTool, ToolchainRecord } from "./registry.js";
import { parseVersion, satisfies } from "./semver.js";

/** Runs a command and returns stdout and stderr, or undefined when it cannot run or fails. */
export type ProbeExec = (
  cmd: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
) => Promise<string | undefined>;

/** A browser of QAJitsu's Playwright and whether it is installed. */
export interface BrowserState {
  readonly name: string;
  readonly version?: string | undefined;
  readonly installed: boolean;
  /** Where Playwright keeps it. */
  readonly path?: string | undefined;
}

/** Ports of {@link detectToolchain}. */
export interface DetectPorts {
  readonly exec: ProbeExec;
  readonly exists: (path: string) => boolean;
  /** The user's environment without what QAJitsu added for its managed tools (see {@link userEnv}). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly host: Host;
  readonly browsers: () => readonly BrowserState[];
}

/** Paths and binaries the project configures explicitly; they come first (explicit config, then the user's tools). */
export interface ExplicitTools {
  readonly androidSdkRoot?: string | undefined;
  readonly appiumBin?: string | undefined;
  readonly appiumHome?: string | undefined;
}

/** A tool found on the machine outside QAJitsu's toolchain. */
export interface SystemTool {
  readonly version?: string | undefined;
  /** Where it was found, e.g. `$JAVA_HOME`, `PATH`, the SDK root. */
  readonly where: string;
  readonly compatible: boolean;
  /** Android packages the SDK lacks, browsers not installed. */
  readonly missing: readonly string[];
  /** Docker: the daemon answers. */
  readonly running?: boolean;
}

/** What is on the machine for one tool (REQ-GEN-06/AC2). */
export interface DetectedTool {
  readonly tool: ToolId;
  readonly needed: boolean;
  readonly why?: string | undefined;
  readonly system?: SystemTool | undefined;
  /** Verified copies QAJitsu installed that still exist. */
  readonly managed: readonly InstalledTool[];
}

const MANAGED_KEYS = ["JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_AVD_HOME", "APPIUM_HOME"];

/**
 * The environment as the user set it: QAJitsu's own additions for managed tools (PATH entries and the variables
 * pointing into the toolchain folder) are removed, so a managed tool is never mistaken for the user's own.
 *
 * @param env - The process environment.
 * @param root - The toolchain folder.
 */
export function userEnv(
  env: Readonly<Record<string, string | undefined>>,
  root: string,
): Record<string, string | undefined> {
  const inside = (value: string | undefined): boolean =>
    value !== undefined && (value === root || value.startsWith(`${root}/`));
  const out: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(env).filter(([key, value]) => !(MANAGED_KEYS.includes(key) && inside(value))),
  );
  if (out["PATH"] !== undefined)
    out["PATH"] = out["PATH"]
      .split(":")
      .filter((p) => !inside(p))
      .join(":");
  return out;
}

/** Default SDK root of Android Studio on each system. */
export const defaultSdkRoot = (host: Host, home: string): string =>
  host.os === "darwin" ? join(home, "Library", "Android", "sdk") : join(home, "Android", "Sdk");

/** The folder that proves an SDK package is installed. */
export function sdkPackagePath(root: string, pkg: string): string {
  const parts = pkg.split(";");
  if (pkg === "platform-tools") return join(root, "platform-tools", "adb");
  if (pkg === "emulator") return join(root, "emulator", "emulator");
  if (pkg === "cmdline-tools;latest") return join(root, "cmdline-tools", "latest", "bin", "sdkmanager");
  return join(root, ...parts);
}

const pathEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  env["PATH"] === undefined ? {} : { PATH: env["PATH"] };

async function detectJava(ports: DetectPorts): Promise<SystemTool | undefined> {
  const home = ports.env["JAVA_HOME"];
  const [cmd, where] =
    home !== undefined && home !== "" ? [join(home, "bin", "java"), "$JAVA_HOME"] : ["java", "PATH"];
  const out = await ports.exec(cmd, ["-version"], pathEnv(ports.env));
  const version = /version "([^"]+)"/.exec(out ?? "")?.[1];
  if (version === undefined) return undefined;
  return { version, where, compatible: satisfies(version, MANIFEST.java.compatible), missing: [] };
}

function detectAndroid(
  ports: DetectPorts,
  needs: ToolchainNeeds,
  explicit: ExplicitTools,
): SystemTool | undefined {
  const root =
    explicit.androidSdkRoot ??
    ports.env["ANDROID_SDK_ROOT"] ??
    ports.env["ANDROID_HOME"] ??
    defaultSdkRoot(ports.host, ports.home);
  if (!ports.exists(root)) return undefined;
  const wanted = ["cmdline-tools;latest", ...(needs.android?.packages ?? ["platform-tools"])];
  const missing = wanted.filter((p) => !ports.exists(sdkPackagePath(root, p)));
  return { where: root, compatible: missing.length === 0, missing };
}

async function detectAppium(
  ports: DetectPorts,
  explicit: ExplicitTools,
): Promise<{ appium?: SystemTool; drivers: Record<string, SystemTool> }> {
  const bin = explicit.appiumBin ?? "appium";
  const home = explicit.appiumHome ?? ports.env["APPIUM_HOME"];
  const env = { ...pathEnv(ports.env), ...(home ? { APPIUM_HOME: home } : {}) };
  const version = /^v?(\d+\.\d+\.\d+)/m.exec((await ports.exec(bin, ["--version"], env)) ?? "")?.[1];
  if (version === undefined) return { drivers: {} };
  const listed = await ports.exec(bin, ["driver", "list", "--installed", "--json"], env);
  let drivers: Record<string, { version?: string }> = {};
  try {
    drivers = JSON.parse(/(\{[\s\S]*\})/.exec(listed ?? "")?.[1] ?? "{}") as typeof drivers;
  } catch {
    drivers = {};
  }
  const where = explicit.appiumBin ?? "PATH";
  return {
    appium: { version, where, compatible: satisfies(version, MANIFEST.appium.compatible), missing: [] },
    drivers: Object.fromEntries(
      (["uiautomator2", "xcuitest"] as const).flatMap((d) => {
        const v = drivers[d]?.version;
        return v === undefined
          ? []
          : [
              [
                d,
                {
                  version: v,
                  where: home ?? "~/.appium",
                  compatible: satisfies(v, MANIFEST[d].compatible),
                  missing: [],
                },
              ],
            ];
      }),
    ),
  };
}

async function detectDocker(ports: DetectPorts): Promise<SystemTool | undefined> {
  const env = pathEnv(ports.env);
  const client = /^v?([\d.]+)/.exec(
    (await ports.exec("docker", ["version", "--format", "{{.Client.Version}}"], env)) ?? "",
  )?.[1];
  if (client === undefined) return undefined;
  const server = /^v?([\d.]+)/.exec(
    (await ports.exec("docker", ["version", "--format", "{{.Server.Version}}"], env)) ?? "",
  )?.[1];
  const compose = /v?(\d+\.\d+\.\d+)/.exec(
    (await ports.exec("docker", ["compose", "version", "--short"], env)) ?? "",
  )?.[1];
  const version = server ?? client;
  return {
    version: `${version}${compose ? `, compose ${compose}` : ""}`,
    where: "PATH",
    compatible: satisfies(version, MANIFEST.docker.compatible) && compose !== undefined,
    missing: compose === undefined ? ["compose"] : [],
    running: server !== undefined,
  };
}

async function detectXcode(ports: DetectPorts): Promise<SystemTool | undefined> {
  if (ports.host.os !== "darwin") return undefined;
  const version = /Xcode (\d+(?:\.\d+)*)/.exec(
    (await ports.exec("xcodebuild", ["-version"], pathEnv(ports.env))) ?? "",
  )?.[1];
  return version === undefined
    ? undefined
    : {
        version,
        where: "xcode-select",
        compatible: satisfies(version, MANIFEST.xcode.compatible),
        missing: [],
      };
}

function detectBrowsers(ports: DetectPorts, needs: ToolchainNeeds): SystemTool | undefined {
  const states = ports.browsers();
  const installed = states.filter((b) => b.installed);
  if (installed.length === 0) return undefined;
  const wanted = needs.browsers.length > 0 ? needs.browsers : states.map((b) => b.name);
  const missing = wanted.filter((w) => !installed.some((b) => b.name === w));
  return {
    // A branded channel (REQ-EXEC-66) is the system's browser; `qj doctor` asks it for its version.
    version: installed.map((b) => (b.version ? `${b.name} ${b.version}` : b.name)).join(", "),
    where: installed.some((b) => b.version === undefined)
      ? "Playwright cache and the system"
      : "Playwright cache",
    compatible: missing.length === 0,
    missing,
  };
}

/**
 * Looks at what is on the machine for every tool (REQ-GEN-06/AC2): the user's own installation with its version and
 * whether it is compatible with QAJitsu's range, and the verified copies QAJitsu installed. Nothing is changed. A
 * version that cannot be read is not compatible: unknown is never assumed to work.
 *
 * @param needs - What the project needs.
 * @param record - What QAJitsu installed.
 * @param ports - Ways to look at the machine.
 * @param explicit - Paths the project configures.
 */
export async function detectToolchain(
  needs: ToolchainNeeds,
  record: ToolchainRecord,
  ports: DetectPorts,
  explicit: ExplicitTools = {},
  /** Tools to look at; default every tool. Others are not asked (doctor and setup ask only what matters). */
  wanted: ReadonlySet<ToolId> = new Set(TOOL_IDS),
): Promise<DetectedTool[]> {
  const managed = (tool: ToolId): InstalledTool[] =>
    record.tools.filter((t) => t.tool === tool && t.verified && ports.exists(t.path));
  const ask = async <T>(tools: readonly ToolId[], probe: () => Promise<T> | T): Promise<T | undefined> =>
    tools.some((t) => wanted.has(t)) ? probe() : undefined;
  const appium = (await ask(["appium", "uiautomator2", "xcuitest"], () => detectAppium(ports, explicit))) ?? {
    drivers: {},
  };
  const system: Record<ToolId, SystemTool | undefined> = {
    browsers: await ask(["browsers"], () => detectBrowsers(ports, needs)),
    docker: await ask(["docker"], () => detectDocker(ports)),
    java: await ask(["java"], () => detectJava(ports)),
    android: await ask(["android"], () => detectAndroid(ports, needs, explicit)),
    appium: appium.appium,
    uiautomator2: appium.drivers["uiautomator2"],
    xcuitest: appium.drivers["xcuitest"],
    xcode: await ask(["xcode"], () => detectXcode(ports)),
  };
  return TOOL_IDS.map((tool) => ({
    tool,
    needed: needs.tools.has(tool),
    why: needs.tools.get(tool),
    system: system[tool],
    managed: managed(tool),
  }));
}

/** The major of a version, for matching `java: 21` to an installed 21.0.4. */
export const majorOf = (version: string): number | undefined => parseVersion(version)?.[0];
