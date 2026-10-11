import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadToolchainConfig, ToolchainFileSchema } from "./config.js";
import { downloadVerified } from "./download.js";
import { applyToolchainEnv, toolchainEnv } from "./env.js";
import {
  installBrowsers,
  installDocker,
  installXcode,
  licenceNames,
  ManualStepError,
  startDocker,
  type InstallContext,
} from "./installers.js";
import { acquireSetupLock } from "./lock.js";
import { hostKey, isToolId, mirrored, type Host } from "./manifest.js";
import { networkFor, sourceUrls, type RunExec } from "./network.js";
import type { PlanStep } from "./plan.js";
import { runPrechecks, type PrecheckPorts } from "./prechecks.js";
import { readToolchainChoice, readToolchainRecord } from "./registry.js";
import { smokeTest } from "./smoke.js";
import { isInside, uninstallTools } from "./uninstall.js";
import { compareVersions } from "./semver.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "qj-tc-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Answer {
  code: number;
  stdout?: string;
  stderr?: string;
}
/** Answers commands by "cmd args" prefix; records every call. */
function scripted(answers: Record<string, Answer> = {}) {
  const calls: { cmd: string; args: readonly string[]; interactive: boolean; env: Record<string, string> }[] =
    [];
  const run: RunExec = (cmd, args, options = {}) => {
    calls.push({ cmd, args, interactive: options.interactive === true, env: { ...options.env } });
    const key = `${cmd} ${args.join(" ")}`;
    const hit = Object.entries(answers).find(([k]) => key.startsWith(k))?.[1] ?? { code: 0 };
    return Promise.resolve({ code: hit.code, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" });
  };
  return { run, calls };
}

const ctxFor = (run: RunExec, extra: Partial<InstallContext> = {}): InstallContext => ({
  root: dir,
  host: { os: "darwin", arch: "arm64" },
  config: ToolchainFileSchema.parse({}),
  exec: run,
  network: networkFor(ToolchainFileSchema.parse({})),
  yes: true,
  interactive: true,
  now: () => new Date("2026-10-09T00:00:00.000Z"),
  home: join(dir, "home"),
  node: "node",
  playwrightCli: "cli.js",
  javaReady: true,
  acceptedLicences: [],
  log: () => undefined,
  ...extra,
});

const step = (tool: PlanStep["tool"], extra: Partial<PlanStep> = {}): PlanStep => ({
  tool,
  action: "install",
  version: "1",
  bytes: 0,
  source: "s",
  licence: "l",
  reason: "r",
  parts: [],
  ...extra,
});

describe("toolchain settings (REQ-GEN-06/AC1+AC7)", () => {
  it("REQ-GEN-06/AC7: the project's toolchain.yaml wins over the machine's key by key", async () => {
    const home = join(dir, "qj");
    const qa = join(dir, ".qa");
    await mkdir(home, { recursive: true });
    await mkdir(qa, { recursive: true });
    await writeFile(
      join(home, "toolchain.yaml"),
      "sources:\n  npm_registry: https://npm.example.test/\nnetwork:\n  proxy: http://proxy.example.test:3128\n  no_proxy: [localhost]\n  ca_certs: ca.pem\nversions:\n  android: { platform: 34 }\n",
    );
    await writeFile(
      join(qa, "toolchain.yaml"),
      "versions:\n  java: '21'\n  android: { build_tools: 35.0.0 }\nnetwork:\n  no_proxy: [internal.example.test]\n",
    );
    const config = await loadToolchainConfig(home, qa);
    expect(config.versions).toEqual({ java: "21", android: { platform: 34, build_tools: "35.0.0" } });
    expect(config.sources.npm_registry).toBe("https://npm.example.test/");
    expect(config.network).toEqual({
      proxy: "http://proxy.example.test:3128",
      no_proxy: ["localhost", "internal.example.test"],
      ca_certs: join(home, "ca.pem"),
    });
    expect(await loadToolchainConfig(join(dir, "none"))).toEqual(ToolchainFileSchema.parse({}));
  });

  it("REQ-GEN-06/AC7: a token must be a secret:// reference; a broken file names the field", async () => {
    await writeFile(join(dir, "toolchain.yaml"), "sources:\n  npm_token: plain-token\n");
    await expect(loadToolchainConfig(dir)).rejects.toMatchObject({
      code: "TOOLCHAIN_CONFIG_INVALID",
      message: expect.stringContaining("sources.npm_token: Expected a secret:// reference") as unknown,
    });
  });

  it("REQ-GEN-06/AC7: proxy, CA and mirrors become the tools' environment; doctor checks every source", () => {
    const config = ToolchainFileSchema.parse({
      sources: {
        playwright_host: "https://pw.example.test",
        android_mirror: "https://android.example.test/repository/",
        homebrew_bottle_domain: "https://brew.example.test/bottles",
        homebrew_api_domain: "https://brew.example.test/api",
        java_mirror: "https://java.example.test",
        npm_registry: "https://npm.example.test",
      },
      network: { proxy: "https://proxy.example.test", no_proxy: ["a", "b"] },
    });
    const n = networkFor(config, { caBundle: "/ca.pem" });
    expect(n.env).toMatchObject({
      HTTPS_PROXY: "https://proxy.example.test",
      NO_PROXY: "a,b",
      PLAYWRIGHT_DOWNLOAD_HOST: "https://pw.example.test",
      SDK_TEST_BASE_URL: "https://android.example.test/repository/",
      HOMEBREW_BOTTLE_DOMAIN: "https://brew.example.test/bottles",
      HOMEBREW_API_DOMAIN: "https://brew.example.test/api",
      SSL_CERT_FILE: "/ca.pem",
      HOMEBREW_NO_ANALYTICS: "1",
    });
    expect(n.sdkmanagerArgs).toEqual(["--proxy=http", "--proxy_host=proxy.example.test", "--proxy_port=443"]);
    expect(n.curlArgs).toEqual([
      "--proxy",
      "https://proxy.example.test",
      "--noproxy",
      "a,b",
      "--cacert",
      "/ca.pem",
    ]);
    expect(sourceUrls(config).map((s) => s.name)).toEqual([
      "npm registry",
      "Playwright download host",
      "Java mirror",
      "Android repository",
      "Homebrew bottles",
      "Homebrew API",
    ]);
    expect(sourceUrls(ToolchainFileSchema.parse({}))).toEqual([
      { name: "Android repository", url: "https://dl.google.com/android/repository/repository2-3.xml" },
    ]);
    expect(
      mirrored("https://github.com/adoptium/x.tgz", "https://github.com/adoptium", "https://m.test/a/"),
    ).toBe("https://m.test/a/x.tgz");
    expect(mirrored("https://other.test/x", "https://github.com/adoptium", "https://m.test")).toBe(
      "https://other.test/x",
    );
  });
});

describe("environment of the processes QAJitsu starts (REQ-GEN-06/AC3+AC9)", () => {
  it("REQ-GEN-06/AC3: managed tools are passed through JAVA_HOME, ANDROID_*, APPIUM_HOME and PATH", () => {
    const te = toolchainEnv(
      {
        schema: 1,
        updated_at: "x",
        tools: {
          java: { use: "managed", path: "/t/java/17/Contents/Home" },
          android: { use: "managed", path: "/t/android/sdk" },
          appium: { use: "managed", path: "/t/appium/3.8.0" },
          uiautomator2: { use: "managed", path: "/t/appium-home/3" },
          browsers: { use: "system" },
        },
      },
      () => true,
    );
    expect(te.vars).toEqual({
      HOMEBREW_NO_ANALYTICS: "1",
      DO_NOT_TRACK: "1",
      JAVA_HOME: "/t/java/17/Contents/Home",
      ANDROID_HOME: "/t/android/sdk",
      ANDROID_SDK_ROOT: "/t/android/sdk",
      ANDROID_AVD_HOME: "/t/android/avd",
      APPIUM_HOME: "/t/appium-home/3",
    });
    const env: Record<string, string | undefined> = {
      PATH: "/usr/bin:/t/java/17/Contents/Home/bin",
      JAVA_HOME: "/mine",
    };
    applyToolchainEnv(env, te);
    expect(env["PATH"]?.split(":")).toEqual([
      "/t/java/17/Contents/Home/bin",
      "/t/android/sdk/platform-tools",
      "/t/android/sdk/emulator",
      "/t/android/sdk/cmdline-tools/latest/bin",
      "/t/appium/3.8.0/node_modules/.bin",
      "/usr/bin",
    ]);
    expect(env["JAVA_HOME"]).toBe("/t/java/17/Contents/Home");
  });

  it("REQ-GEN-06/AC2+AC9: the user's own tools stay as they are; a removed managed folder is ignored; analytics off", () => {
    const te = toolchainEnv(
      {
        schema: 1,
        updated_at: "x",
        tools: { java: { use: "system", path: "PATH" }, android: { use: "managed", path: "/gone" } },
      },
      () => false,
    );
    expect(te).toEqual({ vars: { HOMEBREW_NO_ANALYTICS: "1", DO_NOT_TRACK: "1" }, path: [] });
    expect(toolchainEnv(undefined, () => true).path).toEqual([]);
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    applyToolchainEnv(env, te);
    expect(env).toEqual({ PATH: "/usr/bin", HOMEBREW_NO_ANALYTICS: "1", DO_NOT_TRACK: "1" });
  });
});

describe("prechecks on Linux (REQ-GEN-06/AC6)", () => {
  const ports = (extra: Partial<PrecheckPorts> = {}): PrecheckPorts => ({
    host: { os: "linux", arch: "x64" },
    exec: () => Promise.resolve("ok"),
    exists: () => true,
    freeBytes: () => Promise.resolve(undefined),
    totalMemory: 6 * 1024 ** 3,
    kvmAccessible: () => true,
    ...extra,
  });
  const needs = (image: string) => ({
    tools: new Map(),
    browsers: [],
    android: { packages: ["emulator", image], emulator: { systemImage: image, avd: "qj" } },
  });
  const androidStep = [step("android", { bytes: 100 })];

  it("REQ-GEN-06/AC6: picks x86_64 images on x64, needs KVM, warns under 8 GiB, unknown disk does not block", async () => {
    const checks = await runPrechecks(
      androidStep,
      needs("system-images;android-34;google_apis;x86_64"),
      ports(),
      dir,
    );
    expect(checks.map((c) => [c.name, c.ok])).toEqual([
      ["processor", true],
      ["emulator build", true],
      ["system image", true],
      ["virtualisation", true],
      ["memory", true],
      ["curl", true],
      ["tar", true],
      ["unzip", true],
      ["disk", true],
    ]);
    expect(checks.find((c) => c.name === "memory")?.detail).toContain("8 GiB or more is recommended");
    expect(checks.find((c) => c.name === "disk")?.detail).toBe("free space unknown");
  });

  it("REQ-GEN-06/AC6: Linux on ARM64 has no Android emulator build", async () => {
    const checks = await runPrechecks(
      androidStep,
      needs("system-images;android-34;google_apis;arm64-v8a"),
      ports({ host: { os: "linux", arch: "arm64" } }),
      dir,
    );
    expect(checks.find((c) => c.name === "emulator build")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("no build for Linux on ARM64") as unknown,
    });
    expect(checks.find((c) => c.name === "system image")?.ok).toBe(true);
  });

  it("REQ-GEN-06/AC6: an arm64 image on x64, no /dev/kvm, too little memory and missing unzip each stop it", async () => {
    const checks = await runPrechecks(
      androidStep,
      needs("system-images;android-34;google_apis;arm64-v8a"),
      ports({
        kvmAccessible: () => false,
        totalMemory: 2 * 1024 ** 3,
        exec: (cmd) => Promise.resolve(cmd === "unzip" ? undefined : "ok"),
      }),
      dir,
    );
    const failed = Object.fromEntries(checks.filter((c) => !c.ok).map((c) => [c.name, c.detail]));
    expect(Object.keys(failed)).toEqual(["system image", "virtualisation", "memory", "unzip"]);
    expect(failed["system image"]).toContain(
      "set mobile.android.emulator.system_image to the x86_64 variant",
    );
    expect(failed["virtualisation"]).toContain("add the user to the kvm group");
    expect(failed["memory"]).toContain("at least 4 GiB");
  });
});

describe("downloads (REQ-GEN-06/AC6)", () => {
  it("REQ-GEN-06/AC6: an interrupted download keeps its partial file to resume; a verified file is reused", async () => {
    const dest = join(dir, "a.zip");
    const failing: RunExec = async (_cmd, args) => {
      await writeFile(args[args.indexOf("--output") + 1] ?? "", "half");
      return { code: 56, stdout: "", stderr: "Recv failure" };
    };
    const checksum = { algorithm: "sha256" as const, value: "0".repeat(64) };
    await expect(
      downloadVerified({ url: "https://x.test/a.zip", checksum, dest }, failing),
    ).rejects.toMatchObject({
      code: "DOWNLOAD_FAILED",
      message: expect.stringContaining("run qj setup again to resume it") as unknown,
    });
    expect(await readFile(`${dest}.part`, "utf8")).toBe("half");
    const resumed = scripted();
    await expect(
      downloadVerified({ url: "https://x.test/a.zip", checksum, dest }, resumed.run),
    ).rejects.toMatchObject({
      code: "CHECKSUM_MISMATCH",
    });
    expect(resumed.calls[0]?.args).toContain("--continue-at");
    const nothing = scripted();
    await expect(
      downloadVerified({ url: "https://x.test/b.zip", checksum, dest: join(dir, "b.zip") }, nothing.run),
    ).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    await writeFile(dest, "done");
    const real = createHash("sha256").update("done").digest("hex");
    const reuse = scripted();
    expect(
      await downloadVerified(
        { url: "https://x.test/a.zip", checksum: { algorithm: "sha256", value: real }, dest },
        reuse.run,
      ),
    ).toBe(dest);
    expect(reuse.calls).toEqual([]);
  });
});

describe("system-wide tools (REQ-GEN-06/AC3)", () => {
  it("REQ-GEN-06/AC3: Docker on macOS is Colima + CLI + Compose from Homebrew, the Compose plugin linked, started", async () => {
    const tools = scripted({ "brew --prefix": { code: 0, stdout: "/opt/homebrew\n" } });
    const entry = await installDocker(ctxFor(tools.run));
    expect(tools.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`)).toEqual([
      "brew --version",
      "brew install colima docker docker-compose",
      "brew --prefix",
      "colima version",
      "colima start",
    ]);
    expect(entry).toMatchObject({
      tool: "docker",
      system: true,
      source: "brew:colima docker docker-compose",
    });
    expect(lstatSync(join(dir, "home", ".docker", "cli-plugins", "docker-compose")).isSymbolicLink()).toBe(
      true,
    );
    // An existing plugin is left alone.
    await installDocker(ctxFor(tools.run));
    expect(tools.calls.every((c) => !c.interactive)).toBe(true);
  });

  it("REQ-GEN-06/AC3: without Homebrew, apt, a terminal or Colima the user gets the manual step", async () => {
    await expect(
      installDocker(ctxFor(scripted({ "brew --version": { code: 1 } }).run)),
    ).rejects.toBeInstanceOf(ManualStepError);
    const linux: Host = { os: "linux", arch: "x64" };
    await expect(
      installDocker(ctxFor(scripted({ "apt-get": { code: 1 } }).run, { host: linux })),
    ).rejects.toThrow(/docs\.docker\.com/);
    await expect(installDocker(ctxFor(scripted().run, { host: linux, interactive: false }))).rejects.toThrow(
      /in a terminal/,
    );
    const apt = scripted();
    expect(await installDocker(ctxFor(apt.run, { host: linux }))).toMatchObject({ system: true });
    expect(apt.calls.filter((c) => c.interactive).map((c) => c.args.join(" "))).toEqual([
      "apt-get install -y docker.io docker-compose-v2",
      "systemctl start docker",
    ]);
    await expect(startDocker(ctxFor(scripted({ "colima version": { code: 1 } }).run))).rejects.toThrow(
      /Docker Desktop, OrbStack or Colima/,
    );
    await expect(startDocker(ctxFor(scripted().run, { host: linux, interactive: false }))).rejects.toThrow(
      /systemctl start docker/,
    );
  });

  it("REQ-GEN-06/AC3+AC4: Xcode comes through xcodes in a terminal; --yes accepts its licence and lists it", async () => {
    await expect(installXcode(ctxFor(scripted().run, { interactive: false }), step("xcode"))).rejects.toThrow(
      /Apple ID/,
    );
    const tools = scripted({ "xcodes version": { code: 1 } });
    const ctx = ctxFor(tools.run);
    const entry = await installXcode(ctx, step("xcode", { version: "16.4" }));
    expect(tools.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`)).toEqual([
      "xcodes version",
      "brew install xcodes",
      "xcodes install 16.4 --select --experimental-unxip",
      "sudo xcodebuild -license accept",
      "sudo xcodebuild -runFirstLaunch",
    ]);
    expect(ctx.acceptedLicences).toEqual(["Xcode and Apple SDKs Agreement"]);
    expect(entry).toMatchObject({ tool: "xcode", version: "16.4", system: true });
    const latest = scripted();
    await installXcode(
      ctxFor(latest.run, { yes: false }),
      step("xcode", { version: "the latest release (xcodes)" }),
    );
    expect(latest.calls.map((c) => c.args.join(" "))).toEqual([
      "version",
      "install --latest --select --experimental-unxip",
      "xcodebuild -runFirstLaunch",
    ]);
  });

  it("REQ-GEN-06/AC1: browsers come from QAJitsu's Playwright; a failed install names the command", async () => {
    const tools = scripted();
    const entry = await installBrowsers(
      ctxFor(tools.run),
      step("browsers", { action: "reinstall", parts: ["firefox"] }),
      "/cache",
      "1.63.0",
    );
    expect(tools.calls[0]?.args).toEqual(["cli.js", "install", "--force", "firefox"]);
    expect(entry).toMatchObject({ tool: "browsers", path: "/cache", parts: ["firefox"], version: "1.63.0" });
    await expect(
      installBrowsers(
        ctxFor(scripted({ node: { code: 1, stderr: "no space" } }).run),
        step("browsers"),
        "/c",
        "1",
      ),
    ).rejects.toMatchObject({
      code: "TOOL_INSTALL_FAILED",
      message: expect.stringContaining("no space") as unknown,
    });
  });
});

describe("smoke tests (REQ-GEN-06/AC8)", () => {
  const entry = (tool: PlanStep["tool"], extra: Record<string, unknown> = {}) => ({
    tool,
    version: "3.8.0",
    path: join(dir, tool),
    source: "s",
    licence: "l",
    installed_at: "x",
    parts: [] as string[],
    verified: false,
    system: false,
    ...extra,
  });

  it("REQ-GEN-06/AC8: every failure names the tool and the next step; nothing that failed is ready", async () => {
    const run = scripted({
      [join(dir, "appium", "node_modules", ".bin", "appium")]: { code: 0, stdout: "2.0.0" },
      "appium driver list": { code: 0, stdout: "{}" },
      "docker info": { code: 1 },
      xcodebuild: { code: 1 },
      [join(dir, "android", "cmdline-tools")]: { code: 1, stderr: "Java not found" },
    }).run;
    const ports = {
      launchBrowser: (b: string) => Promise.resolve(b === "webkit" ? "missing libraries" : undefined),
    };
    const ctx = ctxFor(run, { host: { os: "linux", arch: "x64" } });
    const results = await Promise.all([
      smokeTest(ctx, entry("appium"), { boot: false, ports }),
      smokeTest(ctx, entry("uiautomator2", { version: "8.7.0" }), { boot: false, ports }),
      smokeTest(ctx, entry("browsers", { parts: ["chromium", "webkit"] }), { boot: false, ports }),
      smokeTest(ctx, entry("docker"), { boot: false, ports }),
      smokeTest(ctx, entry("xcode"), { boot: false, ports }),
      smokeTest(ctx, entry("android", { parts: ["platform-tools"] }), { boot: false, ports }),
    ]);
    expect(results.map((r) => [r.tool, r.ok, r.next])).toEqual([
      ["appium", false, "qj setup --reinstall appium"],
      ["uiautomator2", false, "qj setup --reinstall uiautomator2"],
      ["browsers", false, "install the browsers' system libraries: sudo npx playwright-core install-deps"],
      ["docker", false, "sudo systemctl start docker; add yourself to the docker group"],
      ["xcode", false, "sudo xcode-select -s /Applications/Xcode.app; xcodebuild -runFirstLaunch"],
      ["android", false, "qj setup --reinstall android"],
    ]);
    expect(results[2].detail).toBe("webkit: missing libraries");
    expect(results[5].detail).toContain("sdkmanager does not run: Java not found");
  });

  it("REQ-GEN-06/AC8: the emulator's acceleration check must pass; --smoke boots it once", async () => {
    const sdk = join(dir, "android");
    const listed = { code: 0, stdout: "emulator | 1\nsystem-images;android-34;google_apis;arm64-v8a | 1" };
    const android = {
      packages: ["emulator", "system-images;android-34;google_apis;arm64-v8a"],
      emulator: { systemImage: "system-images;android-34;google_apis;arm64-v8a", avd: "qj" },
    };
    const e = entry("android", { path: sdk, parts: [...android.packages, "avd:qj"] });
    const noAccel = scripted({
      [join(sdk, "cmdline-tools")]: listed,
      [join(sdk, "emulator")]: { code: 1, stdout: "accel:\n1\nHVF is not supported" },
    });
    const r1 = await smokeTest(ctxFor(noAccel.run), e, { android, boot: false, ports: {} });
    expect(r1).toMatchObject({ ok: false, next: expect.stringContaining("device farm") as unknown });
    const accel = scripted({
      [join(sdk, "cmdline-tools")]: listed,
      [join(sdk, "emulator")]: { code: 0, stdout: "accel:\n0\nok" },
    });
    const booted: string[] = [];
    const r2 = await smokeTest(ctxFor(accel.run), e, {
      android,
      boot: true,
      ports: {
        bootEmulator: (s, avd) => {
          booted.push(`${s}:${avd}`);
          return Promise.resolve(undefined);
        },
      },
    });
    expect(r2).toMatchObject({ ok: true, detail: "sdkmanager lists 2 packages; the emulator booted" });
    expect(booted).toEqual([`${sdk}:qj`]);
    const r3 = await smokeTest(ctxFor(accel.run), e, {
      android,
      boot: true,
      ports: { bootEmulator: () => Promise.resolve("boot timed out") },
    });
    expect(r3).toMatchObject({ ok: false, detail: "the emulator did not boot: boot timed out" });
    expect(licenceNames("1/2: License a-b:\nLicense a-b:\n2/2: License c.d:\n")).toEqual(["a-b", "c.d"]);
  });
});

describe("record, lock and uninstall (REQ-GEN-06/AC3+AC5+AC6)", () => {
  it("REQ-GEN-06/AC3: a broken record stops every change instead of guessing what was installed", async () => {
    await writeFile(join(dir, "installed.json"), "{ not json");
    await expect(readToolchainRecord(dir)).rejects.toMatchObject({ code: "TOOLCHAIN_RECORD_INVALID" });
    await writeFile(join(dir, "toolchain.json"), "{}");
    expect(await readToolchainChoice(dir)).toBeUndefined();
  });

  it("REQ-GEN-06/AC6: a lock is released only by its owner", async () => {
    const lock = await acquireSetupLock(dir, 4242, () => true);
    await expect(acquireSetupLock(dir, 4343, () => true)).rejects.toMatchObject({ code: "TOOLCHAIN_LOCKED" });
    await lock.release();
    const second = await acquireSetupLock(dir, 4343, () => true);
    await lock.release();
    expect(existsSync(join(dir, ".setup.lock"))).toBe(true);
    await second.release();
    expect(existsSync(join(dir, ".setup.lock"))).toBe(false);
  });

  it("REQ-GEN-06/AC5: --uninstall --all removes drivers, browsers and downloads but keeps system tools", async () => {
    const base = { source: "s", licence: "l", installed_at: "x", parts: [], verified: true, system: false };
    const home = join(dir, "appium-home", "3");
    await mkdir(home, { recursive: true });
    await mkdir(join(dir, ".downloads"), { recursive: true });
    await writeFile(
      join(dir, "installed.json"),
      JSON.stringify({
        schema: 1,
        tools: [
          { ...base, tool: "uiautomator2", version: "8.7.0", path: home },
          { ...base, tool: "browsers", version: "1.63.0", path: "/cache", parts: ["chromium"] },
          { ...base, tool: "xcode", version: "16.4", path: "/Applications", system: true },
        ],
      }),
    );
    const tools = scripted();
    const report = await uninstallTools(dir, "all", {
      run: tools.run,
      node: "node",
      playwrightCli: "cli.js",
      log: () => undefined,
    });
    expect(report.removed.map((e) => e.tool)).toEqual(["uiautomator2", "browsers"]);
    expect(report.kept.map((k) => k.entry.tool)).toEqual(["xcode"]);
    expect(tools.calls.map((c) => c.args.join(" "))).toEqual(["cli.js uninstall"]);
    expect(existsSync(home)).toBe(false);
    expect(existsSync(join(dir, ".downloads"))).toBe(false);
    expect((await readToolchainRecord(dir)).tools.map((t) => t.tool)).toEqual(["xcode"]);
  });

  it("REQ-GEN-06/AC5: one driver of two is uninstalled through Appium; a failed browser uninstall is kept", async () => {
    const base = { source: "s", licence: "l", installed_at: "x", parts: [], verified: true, system: false };
    const home = join(dir, "appium-home", "3");
    await writeFile(
      join(dir, "installed.json"),
      JSON.stringify({
        schema: 1,
        tools: [
          { ...base, tool: "appium", version: "3.8.0", path: join(dir, "appium", "3.8.0") },
          { ...base, tool: "uiautomator2", version: "8.7.0", path: home },
          { ...base, tool: "xcuitest", version: "12.16.0", path: home },
          { ...base, tool: "browsers", version: "1.63.0", path: "/cache" },
        ],
      }),
    );
    const tools = scripted({ node: { code: 1, stderr: "busy" } });
    const report = await uninstallTools(dir, ["xcuitest", "browsers"], {
      run: tools.run,
      node: "node",
      playwrightCli: "cli.js",
      log: () => undefined,
    });
    expect(tools.calls[0]).toMatchObject({
      cmd: join(dir, "appium", "3.8.0", "node_modules", ".bin", "appium"),
      args: ["driver", "uninstall", "xcuitest"],
      env: { APPIUM_HOME: home },
    });
    expect(report.kept.map((k) => k.reason)).toEqual(["playwright uninstall failed: busy"]);
  });

  it("checks containment and tool names strictly", () => {
    expect(isInside("/t/java/17", "/t")).toBe(true);
    expect(isInside("/t", "/t")).toBe(false);
    expect(isInside("/t/../etc", "/t")).toBe(false);
    expect(isInside("/tx/a", "/t")).toBe(false);
    expect(isToolId("java")).toBe(true);
    expect(isToolId("python")).toBe(false);
    expect(hostKey({ os: "linux", arch: "arm64" })).toBe("linux-arm64");
    expect(compareVersions("unknown", "1")).toBeLessThan(0);
  });
});

describe("offline bundles (REQ-GEN-06/AC7)", () => {
  it("REQ-GEN-06/AC7: drivers from a bundle drop Appium's cached manifest with the bundle's absolute paths", async () => {
    const { writeBundleManifest, importBundle } = await import("./offline.js");
    const { recordInstalled } = await import("./registry.js");
    const bundle = join(dir, "bundle");
    const home = join(bundle, "toolchain", "appium-home", "3");
    const manifest = join(home, "node_modules", ".cache", "appium", "extensions.yaml");
    await mkdir(join(home, "node_modules", "appium-uiautomator2-driver"), { recursive: true });
    await mkdir(join(manifest, ".."), { recursive: true });
    await writeFile(manifest, `installPath: ${home}/node_modules/appium-uiautomator2-driver\n`);
    await recordInstalled(join(bundle, "toolchain"), {
      tool: "uiautomator2",
      version: "8.7.0",
      path: home,
      source: "npm",
      licence: "Apache-2.0",
      installed_at: "x",
      parts: [],
      verified: true,
      system: false,
    });
    const host = { os: "darwin", arch: "arm64" } as const;
    await writeBundleManifest(bundle, host, () => new Date(0));
    const root = join(dir, "toolchain");
    const imported = await importBundle(bundle, root, host, join(dir, "cache"), () => new Date(0));
    expect(imported.tools.map((t) => [t.tool, t.path])).toEqual([
      ["uiautomator2", join(root, "appium-home", "3")],
    ]);
    expect(existsSync(join(root, "appium-home", "3", "node_modules", "appium-uiautomator2-driver"))).toBe(
      true,
    );
    expect(
      existsSync(join(root, "appium-home", "3", "node_modules", ".cache", "appium", "extensions.yaml")),
    ).toBe(false);
    await writeFile(join(bundle, "bundle.json"), "{}");
    await expect(
      importBundle(bundle, root, host, join(dir, "cache"), () => new Date(0)),
    ).rejects.toMatchObject({
      code: "BUNDLE_INVALID",
    });
  });
});
