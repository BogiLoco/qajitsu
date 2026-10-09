import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, platform, release, type } from "node:os";
import { dirname, join, resolve } from "node:path";
import { androidSdkRoot } from "@qajitsu/adapter-runner-mobile";
import { webCombinations } from "@qajitsu/core";
import type { LoadedProject } from "./project.js";

/** Runs a command and returns its output (stdout and stderr), or undefined when it cannot run. */
export type VersionExec = (
  cmd: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
) => Promise<string | undefined>;

/** Version of one tool, and whether this project needs it (REQ-GEN-03/AC4, REQ-OBS-10/AC1). */
export interface ToolVersion {
  readonly name: string;
  /** Undefined when the tool is missing or does not report a version: it is unknown, never guessed. */
  readonly version?: string | undefined;
  /** Needed by this project's configuration (test types, services, mobile). */
  readonly needed: boolean;
  /** Why it is needed, e.g. "web tests". */
  readonly why?: string | undefined;
  /** How to install it when it is missing. */
  readonly install?: string | undefined;
}

/** Playwright and its browsers: the package version, each browser's version and whether it is installed. */
export interface PlaywrightInfo {
  readonly version?: string | undefined;
  readonly browsers: readonly {
    readonly name: string;
    readonly version?: string;
    readonly installed: boolean;
  }[];
}

/** The real command runner: 15 s, output of stdout and stderr (`java -version` writes to stderr). */
export const execVersion: VersionExec = (cmd, args, env) =>
  new Promise((done) => {
    execFile(
      cmd,
      [...args],
      { timeout: 15_000, ...(env ? { env: { ...process.env, ...env } } : {}) },
      (error, stdout, stderr) => {
        done(error ? undefined : `${stdout}\n${stderr}`.trim());
      },
    );
  });

/** Playwright of the CLI and its browsers, from `playwright-core` itself. */
export function playwrightInfo(): PlaywrightInfo {
  try {
    const require = createRequire(import.meta.url);
    // The package's `exports` hide its files from require; they are read next to its entry point.
    const dir = dirname(require.resolve("playwright-core"));
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string };
    const manifest = JSON.parse(readFileSync(join(dir, "browsers.json"), "utf8")) as {
      browsers: { name: string; browserVersion?: string }[];
    };
    const pw = require("playwright-core") as Record<string, { executablePath(): string } | undefined>;
    return {
      version: pkg.version,
      browsers: ["chromium", "firefox", "webkit"].map((name) => {
        const installed = (() => {
          try {
            return existsSync(pw[name]?.executablePath() ?? "");
          } catch {
            return false;
          }
        })();
        const version = manifest.browsers.find((b) => b.name === name)?.browserVersion;
        return { name, installed, ...(version ? { version } : {}) };
      }),
    };
  } catch {
    return { browsers: [] };
  }
}

const first = (text: string | undefined, pattern: RegExp): string | undefined =>
  pattern.exec(text ?? "")?.[1];

/** The revision of an Android SDK package from its `package.xml` (`<major>`, `<minor>`, `<micro>`). */
async function sdkPackageRevision(dir: string): Promise<string | undefined> {
  const xml = await readFile(join(dir, "package.xml"), "utf8").catch(() => undefined);
  const part = (tag: string) => first(xml, new RegExp(`<revision>[\\s\\S]*?<${tag}>(\\d+)</${tag}>`));
  const major = part("major");
  return major === undefined ? undefined : [major, part("minor"), part("micro")].filter(Boolean).join(".");
}

/**
 * Versions of QAJitsu and every tool it can use, each marked as needed or not by the project (REQ-GEN-03/AC4).
 * A tool that is missing or does not answer has no version; it is never guessed (REQ-OBS-10/AC4).
 *
 * @param input - QAJitsu and Node.js versions, the project (optional) and the ways to ask the tools.
 */
export async function toolVersions(input: {
  readonly qajitsu: string;
  readonly node: string;
  readonly project?: LoadedProject | undefined;
  readonly exec?: VersionExec;
  readonly playwright?: () => PlaywrightInfo;
  /** Ask only the tools the project needs (a run); `qj doctor` asks every tool. */
  readonly neededOnly?: boolean;
}): Promise<ToolVersion[]> {
  const run = input.exec ?? execVersion;
  const exec = (needed: boolean): VersionExec =>
    needed || input.neededOnly !== true ? run : () => Promise.resolve(undefined);
  const config = input.project?.config;
  const web = config?.test_types.includes("web") === true;
  const browsers =
    config && web ? new Set(webCombinations(config.web).map((c) => c.browser)) : new Set<string>();
  const docker = Object.values(config?.services ?? {}).some((s) => s.kind !== "process");
  const android = config?.mobile?.android !== undefined;
  const appium = config?.mobile !== undefined && config.mobile.appium.url === undefined;
  const ios = config?.mobile?.ios !== undefined && config.mobile.ios.farm === undefined;
  const out: ToolVersion[] = [
    { name: "qajitsu", version: input.qajitsu, needed: true },
    {
      name: "os",
      version: `${
        platform() === "darwin"
          ? `macOS ${first(await exec(true)("sw_vers", ["-productVersion"]), /([\d.]+)/) ?? release()}`
          : `${type()} ${release()}`
      } (${arch()})`,
      needed: true,
    },
    { name: "node", version: input.node, needed: true },
    {
      name: "git",
      version: first(await exec(true)("git", ["--version"]), /git version ([\w.-]+)/),
      needed: true,
      why: "fetching the change",
      install: "install git from https://git-scm.com",
    },
    {
      name: "docker",
      version: first(
        await exec(docker)("docker", ["version", "--format", "{{.Server.Version}}"]),
        /^([\w.+-]+)/,
      ),
      needed: docker,
      why: "--build with compose services",
      install: "install Docker with Compose v2 and start it",
    },
    {
      name: "compose",
      version: first(await exec(docker)("docker", ["compose", "version", "--short"]), /v?([\d.]+)/),
      needed: docker,
      why: "--build with compose services",
      install: "install Docker Compose v2 (docker compose)",
    },
  ];
  const pw = (input.playwright ?? playwrightInfo)();
  out.push({ name: "playwright", version: pw.version, needed: web, why: "web tests" });
  for (const b of pw.browsers)
    out.push({
      name: b.name,
      version: b.installed ? b.version : undefined,
      needed: browsers.has(b.name),
      why: "web tests",
      install: `pnpm --filter @qajitsu/cli exec playwright-core install ${b.name}`,
    });
  out.push({
    name: "java",
    version: first(await exec(android)("java", ["-version"]), /version "([^"]+)"/),
    needed: android,
    why: "Android tests",
    install: "install a JDK 17 or newer (e.g. Temurin)",
  });
  const sdk = androidSdkRoot(config?.mobile?.android?.sdk_root);
  const platforms = (await readdir(join(sdk, "platforms")).catch(() => [] as string[])).sort();
  const buildTools = (await readdir(join(sdk, "build-tools")).catch(() => [] as string[])).sort();
  out.push({
    name: "android sdk",
    version:
      platforms.length > 0
        ? `${platforms.join(", ")}${buildTools.length > 0 ? `; build-tools ${buildTools.join(", ")}` : ""}`
        : undefined,
    needed: android,
    why: "Android tests",
    install: 'sdkmanager "platforms;android-34" "build-tools;34.0.0" (see docs/guides/mobile.md)',
  });
  out.push({
    name: "emulator",
    version: await sdkPackageRevision(join(sdk, "emulator")),
    needed: config?.mobile?.android?.emulator !== undefined,
    why: "Android tests on an emulator",
    install: "sdkmanager emulator",
  });
  const appiumBin =
    config?.mobile?.appium.bin?.includes("/") === true
      ? resolve(input.project?.qaDir ?? ".", config.mobile.appium.bin)
      : (config?.mobile?.appium.bin ?? "appium");
  const appiumHome = config?.mobile?.appium.home;
  const appiumEnv = appiumHome
    ? { APPIUM_HOME: resolve(input.project?.qaDir ?? ".", appiumHome) }
    : undefined;
  out.push({
    name: "appium",
    version: first(await exec(appium)(appiumBin, ["--version"], appiumEnv), /^([\d.]+)/m),
    needed: appium,
    why: "mobile tests",
    install: "npm install -g appium",
  });
  if (appium) {
    const listed = await exec(appium)(appiumBin, ["driver", "list", "--installed", "--json"], appiumEnv);
    const drivers = ((): Record<string, { version?: string }> => {
      try {
        return JSON.parse(first(listed, /(\{[\s\S]*\})/) ?? "{}") as Record<string, { version?: string }>;
      } catch {
        return {};
      }
    })();
    const wanted = [...(android ? ["uiautomator2"] : []), ...(ios ? ["xcuitest"] : [])];
    for (const d of wanted)
      out.push({
        name: `appium ${d}`,
        version: drivers[d]?.version,
        needed: true,
        why: "mobile tests",
        install: `appium driver install ${d}`,
      });
  }
  if (platform() === "darwin" || ios)
    out.push({
      name: "xcode",
      version: first(await exec(ios)("xcodebuild", ["-version"]), /Xcode ([\d.]+)/),
      needed: ios,
      why: "iOS tests on this Mac",
      install: "install Xcode from the App Store, or use mobile.ios.farm",
    });
  return out;
}

/**
 * The "Versions" section of `qj doctor` (REQ-GEN-03/AC4): ✔ found, ✘ missing and needed (with the install
 * command), · missing and not needed by this project.
 */
export function formatToolVersions(tools: readonly ToolVersion[]): string {
  const width = Math.max(...tools.map((t) => t.name.length));
  return [
    "Versions:",
    ...tools.map((t) => {
      const name = t.name.padEnd(width);
      if (t.version !== undefined) return `  ✔ ${name}  ${t.version}`;
      if (t.needed)
        return `  ✘ ${name}  not found (needed for ${t.why ?? "this project"})${t.install ? `; install: ${t.install}` : ""}`;
      return `  · ${name}  not found (not needed by this project)`;
    }),
  ].join("\n");
}

/** `{ name: version }` of the tools, `unknown` for one that did not report a version (REQ-OBS-10/AC4). */
export function versionRecord(tools: readonly ToolVersion[]): Record<string, string> {
  return Object.fromEntries(tools.map((t) => [t.name, t.version ?? "unknown"]));
}

/** Version of the installed QAJitsu CLI, from its package.json (src/ and dist/ are both one level below it). */
export function qajitsuVersion(): string {
  try {
    return (
      (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string })
        .version ?? "unknown"
    );
  } catch {
    return "unknown";
  }
}

/**
 * The versions a run records (REQ-OBS-10/AC1): QAJitsu, the operating system, Node.js and git; every tool the
 * project needs (Playwright and its browsers for web tests, Docker and Compose for compose services, Java, the
 * Android SDK, emulator, Appium and its driver for mobile tests); and the model of each agent role. A version that
 * cannot be read is `unknown` (AC4).
 */
export async function runVersions(
  project: LoadedProject,
  options: {
    readonly exec?: VersionExec | undefined;
    readonly playwright?: (() => PlaywrightInfo) | undefined;
  },
): Promise<Record<string, string>> {
  const tools = await toolVersions({
    qajitsu: qajitsuVersion(),
    node: process.version,
    project,
    neededOnly: true,
    ...(options.exec ? { exec: options.exec } : {}),
    ...(options.playwright ? { playwright: options.playwright } : {}),
  });
  const always = new Set(["qajitsu", "os", "node", "git"]);
  return {
    ...versionRecord(tools.filter((t) => always.has(t.name) || t.needed)),
    ...Object.fromEntries(
      Object.entries(project.config.models.roles).map(([role, model]) => [`model ${role}`, model]),
    ),
  };
}
