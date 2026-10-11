import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AdapterError } from "@qajitsu/core";
import { z } from "zod";
import type { ToolchainFile } from "./config.js";
import { downloadVerified } from "./download.js";
import {
  ANDROID_BASE,
  CMDLINE_TOOLS,
  hostKey,
  JAVA_ARTIFACTS,
  JAVA_BASE,
  JAVA_RELEASE,
  MANIFEST,
  mirrored,
  type Artifact,
  type Host,
  type ToolId,
} from "./manifest.js";
import type { Network, RunExec } from "./network.js";
import type { AndroidNeeds } from "./needs.js";
import { managedAndroid, managedAppiumHome, type PlanStep } from "./plan.js";
import { toolDir, type InstalledTool } from "./registry.js";

/** Everything an installer needs. */
export interface InstallContext {
  readonly root: string;
  readonly host: Host;
  readonly config: ToolchainFile;
  readonly exec: RunExec;
  readonly network: Network;
  /** Accept licences and answer tools' questions on the user's behalf (`--yes`). */
  readonly yes: boolean;
  /** A terminal is attached: tools that ask (sudo, Apple ID, licences without --yes) can ask the user. */
  readonly interactive: boolean;
  readonly now: () => Date;
  readonly home: string;
  /** `node` and Playwright's CLI script, to install browsers. */
  readonly node: string;
  readonly playwrightCli: string;
  /** The JAVA_HOME sdkmanager and avdmanager run with; undefined uses `java` on PATH. */
  readonly javaHome?: string | undefined;
  /** A compatible Java is there (the user's or QAJitsu's); sdkmanager needs it. */
  readonly javaReady: boolean;
  /** The Appium executable the drivers are installed with. */
  readonly appiumBin?: string | undefined;
  /** The project's emulators: the image and hardware profile of each AVD to create (REQ-EXEC-20/AC5). */
  readonly android?: AndroidNeeds | undefined;
  /** The pinned archives; tests replace them, everything else uses the manifest's. */
  readonly artifacts?: { readonly java?: Artifact; readonly cmdlineTools?: Artifact } | undefined;
  /** Licences accepted on the user's behalf, collected for the summary (AC4). */
  readonly acceptedLicences: string[];
  readonly log: (line: string) => void;
}

/** A step the user has to do; setup reports it with the command and never reports the tool ready. */
export class ManualStepError extends AdapterError {
  constructor(message: string) {
    super("TOOLCHAIN_MANUAL_STEP", message, {});
  }
}

const tmpName = (dir: string): string => `${dir}.tmp-${randomBytes(4).toString("hex")}`;

const must = async (
  ctx: InstallContext,
  cmd: string,
  args: readonly string[],
  options: Parameters<RunExec>[2] = {},
): Promise<string> => {
  const result = await ctx.exec(cmd, args, { ...options, env: { ...ctx.network.env, ...options.env } });
  if (result.code !== 0)
    throw new AdapterError(
      "TOOL_INSTALL_FAILED",
      `${basename(cmd)} ${args.slice(0, 3).join(" ")} failed (exit ${String(result.code)}): ${(result.stderr || result.stdout).trim().slice(-500)}`,
      { cmd: basename(cmd) },
    );
  return result.stdout;
};

/**
 * Moves a finished folder into place: the old one (a reinstall) is moved aside first and deleted only after the new
 * one is in place, so a failed install never leaves a half-written tool (REQ-GEN-06/AC6).
 */
export async function swapInto(staged: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const old = (await stat(target).catch(() => undefined)) ? tmpName(`${target}.old`) : undefined;
  if (old !== undefined) await rename(target, old);
  try {
    await rename(staged, target);
  } catch (error) {
    if (old !== undefined) await rename(old, target);
    throw error;
  }
  if (old !== undefined) await rm(old, { recursive: true, force: true });
}

const AdoptiumAssetsSchema = z
  .array(
    z.object({
      release_name: z.string(),
      binary: z.object({
        package: z.object({
          link: z.url(),
          checksum: z.string().regex(/^[a-f0-9]{64}$/),
          size: z.number().int().positive(),
        }),
      }),
    }),
  )
  .min(1);

/** The Temurin release of a version: the pinned one from the manifest, else the latest of a major from Adoptium. */
export async function javaArtifact(
  ctx: InstallContext,
  version: string,
): Promise<{ release: string; artifact: Artifact }> {
  if (version === JAVA_RELEASE)
    return { release: JAVA_RELEASE, artifact: ctx.artifacts?.java ?? JAVA_ARTIFACTS[hostKey(ctx.host)] };
  const major = /^(\d+)/.exec(version)?.[1];
  if (major === undefined || version.includes("."))
    throw new AdapterError(
      "JAVA_VERSION_UNSUPPORTED",
      `Java ${version}: give a major version (e.g. 21) or QAJitsu's pinned ${JAVA_RELEASE}.`,
      {},
    );
  const query = new URLSearchParams({
    image_type: "jdk",
    vendor: "eclipse",
    os: ctx.host.os === "darwin" ? "mac" : "linux",
    architecture: ctx.host.arch === "arm64" ? "aarch64" : "x64",
  });
  const json = await must(ctx, "curl", [
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    ...ctx.network.curlArgs,
    `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?${query.toString()}`,
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    parsed = undefined;
  }
  const assets = AdoptiumAssetsSchema.safeParse(parsed);
  if (!assets.success)
    throw new AdapterError(
      "JAVA_RELEASE_UNKNOWN",
      `Adoptium lists no Temurin ${major} JDK for this machine.`,
      {},
    );
  const first = assets.data[0];
  if (!first) throw new AdapterError("JAVA_RELEASE_UNKNOWN", `No Temurin ${major} release.`, {});
  return {
    release: first.release_name.replace(/^jdk-?/, ""),
    artifact: {
      url: first.binary.package.link,
      size: first.binary.package.size,
      checksum: { algorithm: "sha256", value: first.binary.package.checksum },
    },
  };
}

const downloadsDir = (root: string): string => join(root, ".downloads");

async function trustCompanyCa(ctx: InstallContext, javaHome: string): Promise<void> {
  const ca = ctx.config.network.ca_certs;
  if (ca === undefined) return;
  const pem = await readFile(ca, "utf8");
  const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  const dir = tmpName(join(ctx.root, ".ca"));
  await mkdir(dir, { recursive: true });
  try {
    for (const [i, cert] of certs.entries()) {
      const file = join(dir, `${String(i)}.pem`);
      await writeFile(file, `${cert}\n`);
      await must(ctx, join(javaHome, "bin", "keytool"), [
        "-importcert",
        "-noprompt",
        "-cacerts",
        "-storepass",
        "changeit",
        "-alias",
        `qajitsu-company-ca-${String(i)}`,
        "-file",
        file,
      ]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Installs a Temurin JDK into `<root>/java/<release>` (REQ-GEN-06/AC1+AC3). */
export async function installJava(ctx: InstallContext, step: PlanStep): Promise<InstalledTool> {
  const { release, artifact } = await javaArtifact(ctx, step.version);
  const url = mirrored(artifact.url, JAVA_BASE, ctx.config.sources.java_mirror);
  ctx.log(`java: downloading Temurin ${release} (${String(Math.round(artifact.size / 1048576))} MB)`);
  const archive = await downloadVerified(
    {
      url,
      checksum: artifact.checksum,
      dest: join(downloadsDir(ctx.root), basename(new URL(artifact.url).pathname)),
    },
    ctx.exec,
    ctx.network.curlArgs,
  );
  const target = toolDir(ctx.root, "java", release);
  const staging = tmpName(target);
  await mkdir(staging, { recursive: true });
  try {
    await must(ctx, "tar", ["-xzf", archive, "-C", staging]);
    const [top] = await readdir(staging);
    if (top === undefined) throw new AdapterError("JAVA_ARCHIVE_EMPTY", `${archive} is empty`, {});
    await swapInto(join(staging, top), target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const home = ctx.host.os === "darwin" ? join(target, "Contents", "Home") : target;
  await trustCompanyCa(ctx, home);
  return {
    tool: "java",
    version: release,
    path: home,
    source: url,
    checksum: `${artifact.checksum.algorithm}:${artifact.checksum.value}`,
    licence: MANIFEST.java.licence,
    installed_at: ctx.now().toISOString(),
    parts: [],
    verified: false,
    system: false,
  };
}

const sdkmanagerOf = (sdk: string): string => join(sdk, "cmdline-tools", "latest", "bin", "sdkmanager");
const avdmanagerOf = (sdk: string): string => join(sdk, "cmdline-tools", "latest", "bin", "avdmanager");

/** Environment of sdkmanager and avdmanager. */
export const androidEnv = (ctx: InstallContext, sdk: string, avdHome: string): Record<string, string> => ({
  ANDROID_SDK_ROOT: sdk,
  ANDROID_HOME: sdk,
  ANDROID_AVD_HOME: avdHome,
  ...(ctx.javaHome !== undefined ? { JAVA_HOME: ctx.javaHome } : {}),
});

/** Licences sdkmanager reports, e.g. `android-sdk-license`. */
export const licenceNames = (output: string): string[] =>
  [...new Set([...output.matchAll(/^(?:\d+\/\d+: )?License ([\w.-]+):/gm)].map((m) => m[1] ?? ""))].filter(
    Boolean,
  );

async function acceptAndroidLicences(
  ctx: InstallContext,
  sdk: string,
  env: Record<string, string>,
): Promise<void> {
  const args = [`--sdk_root=${sdk}`, ...ctx.network.sdkmanagerArgs, "--licenses"];
  if (ctx.yes) {
    const out = await must(ctx, sdkmanagerOf(sdk), args, { env, input: "y\n".repeat(50) });
    // sdkmanager records each accepted licence as a file in <sdk>/licenses; that is what is listed.
    const accepted = await readdir(join(sdk, "licenses")).catch(() => [] as string[]);
    const names = accepted.length > 0 ? accepted : licenceNames(out);
    ctx.acceptedLicences.push(
      ...names
        .filter((n) => !n.startsWith("."))
        .sort()
        .map((l) => `Android SDK: ${l}`),
    );
    return;
  }
  if (!ctx.interactive)
    throw new ManualStepError(
      "the Android SDK licences need to be accepted: run qj setup in a terminal, or with --yes to accept them",
    );
  await must(ctx, sdkmanagerOf(sdk), args, { env, interactive: true });
}

/**
 * Installs QAJitsu's Android SDK (REQ-GEN-06/AC1+AC3+AC4): the command-line tools from the verified archive, the
 * licences (accepted on the user's behalf only with `--yes`), the packages the project needs through sdkmanager (which
 * verifies each package against Google's checksums) and the AVD of the configured emulator.
 */
export async function installAndroid(
  ctx: InstallContext,
  step: PlanStep,
  current: InstalledTool | undefined,
): Promise<InstalledTool> {
  if (!ctx.javaReady)
    throw new AdapterError(
      "JAVA_NEEDED",
      "sdkmanager needs Java 17 or newer: set up java first (do not --skip java)",
      {},
    );
  const { sdk, avd } = managedAndroid(ctx.root);
  const env = androidEnv(ctx, sdk, avd);
  const fresh = step.action === "reinstall" || current === undefined;
  const artifact = ctx.artifacts?.cmdlineTools ?? CMDLINE_TOOLS[hostKey(ctx.host)];
  const url = mirrored(artifact.url, ANDROID_BASE, ctx.config.sources.android_mirror);
  if (fresh) {
    ctx.log("android: downloading the command-line tools");
    const archive = await downloadVerified(
      { url, checksum: artifact.checksum, dest: join(downloadsDir(ctx.root), basename(artifact.url)) },
      ctx.exec,
      ctx.network.curlArgs,
    );
    const staging = tmpName(sdk);
    await mkdir(staging, { recursive: true });
    try {
      await must(ctx, "unzip", ["-q", archive, "-d", staging]);
      // The archive holds cmdline-tools/; sdkmanager expects it at cmdline-tools/latest.
      await mkdir(join(staging, "sdk", "cmdline-tools"), { recursive: true });
      await rename(join(staging, "cmdline-tools"), join(staging, "sdk", "cmdline-tools", "latest"));
      await swapInto(join(staging, "sdk"), sdk);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  await acceptAndroidLicences(ctx, sdk, env);
  const packages = step.parts.filter((p) => !p.startsWith("avd:"));
  if (packages.length > 0) {
    ctx.log(`android: sdkmanager ${packages.join(" ")}`);
    await must(
      ctx,
      sdkmanagerOf(sdk),
      [`--sdk_root=${sdk}`, ...ctx.network.sdkmanagerArgs, "--install", ...packages],
      {
        env,
        ...(ctx.yes ? { input: "y\n".repeat(50) } : {}),
        ...(ctx.interactive && !ctx.yes ? { interactive: true } : {}),
      },
    );
  }
  const avds = step.parts.filter((p) => p.startsWith("avd:")).map((p) => p.slice(4));
  const images = [...packages, ...(current?.parts ?? [])].filter((p) => p.startsWith("system-images;"));
  for (const name of avds) {
    const wanted = ctx.android?.emulators.find((e) => e.avd === name);
    const image = wanted?.systemImage ?? images[0];
    if (image === undefined)
      throw new AdapterError("AVD_IMAGE_MISSING", `no system image for AVD ${name}`, {});
    await mkdir(avd, { recursive: true });
    await must(
      ctx,
      avdmanagerOf(sdk),
      [
        "create",
        "avd",
        "--name",
        name,
        "--package",
        image,
        ...(wanted?.device ? ["--device", wanted.device] : []),
        "--force",
      ],
      {
        env,
        // "Do you wish to create a custom hardware profile?" gets "no".
        input: "no\n",
      },
    );
  }
  return {
    tool: "android",
    version: "sdk",
    path: sdk,
    source: fresh ? url : current.source,
    checksum: `${artifact.checksum.algorithm}:${artifact.checksum.value}`,
    licence: MANIFEST.android.licence,
    installed_at: ctx.now().toISOString(),
    parts: [...new Set([...(fresh ? [] : current.parts), ...step.parts])],
    verified: false,
    system: false,
  };
}

/** Installs Appium from npm into `<root>/appium/<version>` (REQ-GEN-06/AC1+AC3). */
export async function installAppium(ctx: InstallContext, step: PlanStep): Promise<InstalledTool> {
  const target = toolDir(ctx.root, "appium", step.version);
  const staging = tmpName(target);
  await mkdir(staging, { recursive: true });
  try {
    ctx.log(`appium: npm install appium@${step.version}`);
    await must(ctx, "npm", [
      "install",
      "--prefix",
      staging,
      "--no-fund",
      "--no-audit",
      "--no-update-notifier",
      "--omit=dev",
      `appium@${step.version}`,
    ]);
    await swapInto(staging, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return {
    tool: "appium",
    version: step.version,
    path: target,
    source: `npm:appium@${step.version}`,
    licence: MANIFEST.appium.licence,
    installed_at: ctx.now().toISOString(),
    parts: [],
    verified: false,
    system: false,
  };
}

/** The Appium executable of a managed Appium prefix. */
export const appiumBinOf = (prefix: string): string => join(prefix, "node_modules", ".bin", "appium");

/** Installs an Appium driver into QAJitsu's Appium home at the pinned version (REQ-GEN-06/AC1+AC5). */
export async function installDriver(
  ctx: InstallContext,
  step: PlanStep & { readonly tool: "uiautomator2" | "xcuitest" },
): Promise<InstalledTool> {
  const home = managedAppiumHome(ctx.root);
  const bin = ctx.appiumBin;
  if (bin === undefined)
    throw new AdapterError("APPIUM_NEEDED", `the ${step.tool} driver needs Appium: do not --skip appium`, {});
  await mkdir(home, { recursive: true });
  const env = { APPIUM_HOME: home };
  // Another version in the home is replaced; a driver that is not there makes uninstall fail, which is fine.
  await ctx.exec(bin, ["driver", "uninstall", step.tool], { env: { ...ctx.network.env, ...env } });
  ctx.log(`${step.tool}: appium driver install appium-${step.tool}-driver@${step.version}`);
  await must(ctx, bin, ["driver", "install", "--source=npm", `appium-${step.tool}-driver@${step.version}`], {
    env,
  });
  return {
    tool: step.tool,
    version: step.version,
    path: home,
    source: `npm:appium-${step.tool}-driver@${step.version}`,
    licence: MANIFEST[step.tool].licence,
    installed_at: ctx.now().toISOString(),
    parts: [],
    verified: false,
    system: false,
  };
}

/** Installs the browsers of QAJitsu's Playwright into Playwright's cache (REQ-GEN-06/AC1). */
export async function installBrowsers(
  ctx: InstallContext,
  step: PlanStep,
  cacheDir: string,
  playwrightVersion: string,
): Promise<InstalledTool> {
  ctx.log(`browsers: playwright install ${step.parts.join(" ")}`);
  await must(ctx, ctx.node, [
    ctx.playwrightCli,
    "install",
    ...(step.action === "reinstall" ? ["--force"] : []),
    ...step.parts,
  ]);
  return {
    tool: "browsers",
    version: playwrightVersion,
    path: cacheDir,
    source: ctx.config.sources.playwright_host ?? "playwright.azureedge.net",
    licence: MANIFEST.browsers.licence,
    installed_at: ctx.now().toISOString(),
    parts: [...step.parts],
    verified: false,
    system: false,
  };
}

const systemEntry = (
  ctx: InstallContext,
  tool: ToolId,
  version: string,
  path: string,
  source: string,
): InstalledTool => ({
  tool,
  version,
  path,
  source,
  licence: MANIFEST[tool].licence,
  installed_at: ctx.now().toISOString(),
  parts: [],
  verified: false,
  system: true,
});

/**
 * Installs Docker once for the machine (REQ-GEN-06/AC3): Colima, the Docker CLI and the Compose plugin from Homebrew
 * on macOS (no Docker Desktop), Docker Engine and Compose from the distribution on Linux (through sudo, so only in a
 * terminal). Then the daemon is started.
 */
export async function installDocker(ctx: InstallContext): Promise<InstalledTool> {
  if (ctx.host.os === "darwin") {
    if ((await ctx.exec("brew", ["--version"])).code !== 0)
      throw new ManualStepError(
        "Homebrew is needed for Docker on macOS: install it from https://brew.sh, then run qj setup again",
      );
    await must(ctx, "brew", ["install", "colima", "docker", "docker-compose"]);
    const prefix = (await must(ctx, "brew", ["--prefix"])).trim();
    const plugins = join(ctx.home, ".docker", "cli-plugins");
    await mkdir(plugins, { recursive: true });
    // The Compose plugin is linked where the Docker CLI looks for plugins; an existing one is left alone.
    await symlink(
      join(prefix, "opt", "docker-compose", "bin", "docker-compose"),
      join(plugins, "docker-compose"),
    ).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    await startDocker(ctx);
    return systemEntry(
      ctx,
      "docker",
      "colima",
      join(prefix, "bin", "colima"),
      "brew:colima docker docker-compose",
    );
  }
  if ((await ctx.exec("apt-get", ["--version"])).code !== 0)
    throw new ManualStepError(
      "install Docker Engine with Compose v2 for your distribution: https://docs.docker.com/engine/install/",
    );
  if (!ctx.interactive)
    throw new ManualStepError(
      "Docker Engine is installed with sudo: run qj setup --only docker in a terminal, or sudo apt-get install -y docker.io docker-compose-v2",
    );
  await must(ctx, "sudo", ["apt-get", "install", "-y", "docker.io", "docker-compose-v2"], {
    interactive: true,
  });
  await startDocker(ctx);
  return systemEntry(ctx, "docker", "docker.io", "/usr/bin/docker", "apt:docker.io docker-compose-v2");
}

/** Starts the Docker daemon: `colima start` on macOS, `systemctl start docker` on Linux. */
export async function startDocker(ctx: InstallContext): Promise<void> {
  if (ctx.host.os === "darwin") {
    if ((await ctx.exec("colima", ["version"])).code !== 0)
      throw new ManualStepError("start your Docker (Docker Desktop, OrbStack or Colima), then run qj doctor");
    await must(ctx, "colima", ["start"]);
    return;
  }
  if (!ctx.interactive) throw new ManualStepError("start Docker: sudo systemctl start docker");
  await must(ctx, "sudo", ["systemctl", "start", "docker"], { interactive: true });
}

/**
 * Installs Xcode once for the machine through xcodes (REQ-GEN-06/AC3), next to any Xcode already there. Apple asks for
 * an Apple ID, so it runs only in a terminal; with `--yes` the Xcode licence is accepted on the user's behalf.
 */
export async function installXcode(ctx: InstallContext, step: PlanStep): Promise<InstalledTool> {
  if (!ctx.interactive)
    throw new ManualStepError("Xcode needs your Apple ID: run qj setup --only xcode in a terminal");
  if ((await ctx.exec("xcodes", ["version"])).code !== 0) await must(ctx, "brew", ["install", "xcodes"]);
  const version = /^\d/.test(step.version) ? step.version : undefined;
  await must(
    ctx,
    "xcodes",
    ["install", ...(version ? [version] : ["--latest"]), "--select", "--experimental-unxip"],
    {
      interactive: true,
    },
  );
  if (ctx.yes) {
    await must(ctx, "sudo", ["xcodebuild", "-license", "accept"], { interactive: true });
    ctx.acceptedLicences.push("Xcode and Apple SDKs Agreement");
  }
  await must(ctx, "sudo", ["xcodebuild", "-runFirstLaunch"], { interactive: true });
  return systemEntry(ctx, "xcode", version ?? "latest", "/Applications", "xcodes");
}
