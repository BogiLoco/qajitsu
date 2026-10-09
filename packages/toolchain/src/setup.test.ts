import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseProjectConfig } from "@qajitsu/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolchainFileSchema, type ToolchainFile } from "./config.js";
import { sdkPackagePath } from "./detect.js";
import type { Artifact } from "./manifest.js";
import { toolchainNeeds } from "./needs.js";
import type { RunExec } from "./network.js";
import { readToolchainChoice, readToolchainRecord, recordInstalled } from "./registry.js";
import { runSetup, runSetupFromBundle, setupExitCode, type SetupInput, type SetupPorts } from "./setup.js";
import { uninstallTools } from "./uninstall.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "qj-toolchain-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sha = (algorithm: "sha256" | "sha1", text: string): string =>
  createHash(algorithm).update(text).digest("hex");
const JDK = "fake temurin archive";
const CMDLINE = "fake cmdline-tools archive";
const artifacts = (jdk = JDK): { java: Artifact; cmdlineTools: Artifact } => ({
  java: {
    url: "https://github.com/adoptium/temurin17-binaries/releases/download/jdk/OpenJDK17U-jdk.tar.gz",
    size: 190 * 1048576,
    checksum: { algorithm: "sha256", value: sha("sha256", jdk) },
  },
  cmdlineTools: {
    url: "https://dl.google.com/android/repository/commandlinetools-mac_arm64-1_latest.zip",
    size: 150 * 1048576,
    checksum: { algorithm: "sha1", value: sha("sha1", CMDLINE) },
  },
});

interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly input?: string | undefined;
}

/** A machine where the installers' commands do what the real tools do, inside the temp folder. */
function fakeTools(
  options: {
    readonly served?: Record<string, string>;
    readonly javaRuns?: boolean;
    readonly offline?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const appiumVersions = new Map<string, string>();
  const drivers = new Map<string, Record<string, { version: string }>>();
  const ok = (stdout = "", stderr = "") => Promise.resolve({ code: 0, stdout, stderr });
  const fail = (stderr = "failed") => Promise.resolve({ code: 1, stdout: "", stderr });
  const touch = async (file: string, text = "#!/bin/sh\n") => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  const run: RunExec = async (cmd, args, opts = {}) => {
    const env = opts.env ?? {};
    calls.push({ cmd, args, env, input: opts.input });
    const name = cmd.split("/").at(-1) ?? cmd;
    if (name === "curl") {
      if (options.offline) return fail("Could not resolve host");
      const url = args.at(-1) ?? "";
      const output = args[args.indexOf("--output") + 1];
      if (url.includes("api.adoptium.net"))
        return ok(
          JSON.stringify([
            {
              release_name: "jdk-21.0.4+7",
              binary: {
                package: {
                  link: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.4%2B7/jdk21.tar.gz",
                  checksum: sha("sha256", "jdk21"),
                  size: 200 * 1048576,
                },
              },
            },
          ]),
        );
      const body =
        options.served?.[url] ?? (url.endsWith(".zip") ? CMDLINE : url.includes("jdk21") ? "jdk21" : JDK);
      if (output) await touch(output, body);
      return ok();
    }
    if (name === "tar") {
      const staging = args[args.indexOf("-C") + 1] ?? "";
      await touch(join(staging, "jdk-17", "Contents", "Home", "bin", "java"));
      await touch(join(staging, "jdk-17", "Contents", "Home", "bin", "keytool"));
      return ok();
    }
    if (name === "unzip") {
      const staging = args[args.indexOf("-d") + 1] ?? "";
      await touch(join(staging, "cmdline-tools", "bin", "sdkmanager"));
      await touch(join(staging, "cmdline-tools", "bin", "avdmanager"));
      return ok();
    }
    if (name === "java")
      return options.javaRuns === false
        ? fail("Bad CPU type")
        : ok("", 'openjdk version "17.0.20.1" 2025-10-21');
    if (name === "keytool") return ok("Certificate was added to keystore");
    if (name === "sdkmanager") {
      const root = (args.find((a) => a.startsWith("--sdk_root=")) ?? "").slice(11);
      if (args.includes("--licenses"))
        return opts.input?.startsWith("y") === true
          ? ok("License android-sdk-license:\n---\nAccept? (y/N): y\nLicense android-sdk-preview-license:\n")
          : fail("licences not accepted");
      if (args.includes("--install")) {
        for (const p of args.slice(args.indexOf("--install") + 1)) await touch(sdkPackagePath(root, p));
        return ok();
      }
      if (args.includes("--list_installed")) {
        const listed = [
          "platform-tools",
          "emulator",
          "platforms;android-34",
          "build-tools;34.0.0",
          "system-images;android-34;google_apis;arm64-v8a",
        ].filter((p) => existsSync(sdkPackagePath(root, p)));
        return ok(listed.map((p) => `  ${p} | 1 | x`).join("\n"));
      }
    }
    if (name === "emulator" && args[0] === "-accel-check") return ok("accel:\n0\nHVF\naccel\n");
    if (name === "avdmanager") {
      await mkdir(join(env["ANDROID_AVD_HOME"] ?? "", `${args[args.indexOf("--name") + 1] ?? ""}.avd`), {
        recursive: true,
      });
      return ok();
    }
    if (name === "npm") {
      const prefix = args[args.indexOf("--prefix") + 1] ?? "";
      const pkg = args.at(-1) ?? "";
      await touch(join(prefix, "node_modules", ".bin", "appium"));
      appiumVersions.set(join(prefix, "node_modules", ".bin", "appium"), pkg.split("@")[1] ?? "");
      return ok();
    }
    if (name === "appium") {
      const home = env["APPIUM_HOME"] ?? "~/.appium";
      if (args[0] === "--version") {
        const own = [...appiumVersions.entries()].find(
          ([bin]) => cmd.startsWith(dirname(bin)) || cmd === bin,
        );
        return ok(own?.[1] ?? "3.8.0");
      }
      if (args[1] === "install") {
        const [, driver = "", pkgVersion = ""] = /appium-(\w+)-driver@([\d.]+)/.exec(args.at(-1) ?? "") ?? [];
        drivers.set(home, { ...drivers.get(home), [driver]: { version: pkgVersion } });
        return ok();
      }
      if (args[1] === "list") return ok(JSON.stringify(drivers.get(home) ?? {}));
      if (args[1] === "uninstall") return fail("not installed");
    }
    if (name === "node") return ok();
    return fail(`unexpected ${cmd} ${args.join(" ")}`);
  };
  return { run, calls };
}

const project = parseProjectConfig({
  project: "shop",
  jira: { type: "file", tickets_dir: "t", project_key: "SHOP" },
  test_types: ["mobile"],
  mobile: {
    android: {
      app: { source: "path", repo: "shop", path: "a.apk" },
      app_id: "a.b",
      emulator: { avd: "qj", system_image: "system-images;android-34;google_apis;arm64-v8a" },
    },
  },
});

function setupInput(
  tools: ReturnType<typeof fakeTools>,
  overrides: Partial<SetupPorts> = {},
  options: SetupInput["options"] = { yes: true },
  file: Partial<ToolchainFile> = {},
  root = join(dir, "toolchain"),
): SetupInput {
  const config = ToolchainFileSchema.parse(file);
  const ports: SetupPorts = {
    exec: () => Promise.resolve(undefined),
    exists: existsSync,
    env: { PATH: "/usr/bin" },
    home: join(dir, "home"),
    host: { os: "darwin", arch: "arm64" },
    browsers: () => [],
    freeBytes: () => Promise.resolve(500 * 1024 ** 3),
    totalMemory: 16 * 1024 ** 3,
    kvmAccessible: () => true,
    run: tools.run,
    log: () => undefined,
    now: () => new Date("2026-10-09T10:00:00.000Z"),
    node: "/usr/bin/node",
    playwrightCli: "/pw/cli.js",
    playwrightVersion: "1.63.0",
    browserCache: join(dir, "ms-playwright"),
    smoke: { launchBrowser: () => Promise.resolve(undefined) },
    artifacts: artifacts(),
    ...overrides,
  };
  // Prechecks ask sysctl and the programs setup uses.
  const probe = ports.exec;
  return {
    root,
    needs: toolchainNeeds(project, config.versions),
    config,
    projectHome: join(dir, "project"),
    options,
    ports: {
      ...ports,
      exec: async (cmd, args, env) =>
        cmd === "sysctl" ? "1" : ["curl", "tar", "unzip"].includes(cmd) ? "ok" : probe(cmd, args, env),
    },
  };
}

describe("qj setup (REQ-GEN-06)", () => {
  it("REQ-GEN-06/AC1+AC3+AC8: installs what the project needs into the toolchain, smoke-tests and records it", async () => {
    const tools = fakeTools();
    const input = setupInput(tools);
    const report = await runSetup(input);
    expect(report.stopped).toBeUndefined();
    expect(report.results.map((r) => [r.tool, r.status])).toEqual([
      ["java", "ready"],
      ["android", "ready"],
      ["appium", "ready"],
      ["uiautomator2", "ready"],
    ]);
    expect(setupExitCode(report)).toBe(0);
    const record = await readToolchainRecord(input.root);
    const java = record.tools.find((t) => t.tool === "java");
    expect(java).toMatchObject({
      version: "17.0.20.1+1",
      path: join(input.root, "java", "17.0.20.1+1", "Contents", "Home"),
      checksum: `sha256:${sha("sha256", JDK)}`,
      verified: true,
      system: false,
    });
    expect(java?.licence).toContain("Temurin");
    const android = record.tools.find((t) => t.tool === "android");
    expect(android).toMatchObject({ path: join(input.root, "android", "sdk"), verified: true });
    expect(android?.parts).toEqual([
      "platform-tools",
      "emulator",
      "system-images;android-34;google_apis;arm64-v8a",
      "avd:qj",
    ]);
    expect(existsSync(join(input.root, "android", "avd", "qj.avd"))).toBe(true);
    expect(record.tools.find((t) => t.tool === "uiautomator2")).toMatchObject({
      version: "8.7.0",
      path: join(input.root, "appium-home", "3"),
    });
    // sdkmanager ran with QAJitsu's Java, never the user's.
    const sdkmanager = tools.calls.find((c) => c.cmd.endsWith("sdkmanager"));
    expect(sdkmanager?.env["JAVA_HOME"]).toBe(java?.path);
    // The project's choice: QAJitsu's copies.
    const choice = await readToolchainChoice(join(dir, "project"));
    expect(choice?.tools.java).toEqual({ use: "managed", version: "17.0.20.1+1", path: java?.path });
    expect(choice?.tools.uiautomator2?.path).toBe(join(input.root, "appium-home", "3"));
    // Nothing half-written is left behind, and the lock is released.
    expect((await readdir(join(input.root, "java"))).filter((f) => f.includes(".tmp"))).toEqual([]);
    expect(existsSync(join(input.root, ".setup.lock"))).toBe(false);
  });

  it("REQ-GEN-06/AC4: --yes accepts the licences on the user's behalf and lists them", async () => {
    const tools = fakeTools();
    const report = await runSetup(setupInput(tools));
    expect(report.licences).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^java: GPL-2.0 with Classpath Exception/),
        expect.stringMatching(/^android: Android Software Development Kit License/),
        "Android SDK: android-sdk-license",
        "Android SDK: android-sdk-preview-license",
      ]),
    );
  });

  it("REQ-GEN-06/AC4: without --yes the licences and every download over 100 MB are confirmed first", async () => {
    const questions: string[] = [];
    const noTerminal = await runSetup(setupInput(fakeTools(), {}, {}));
    expect(noTerminal.stopped).toContain("run it in a terminal, or with --yes");
    expect(setupExitCode(noTerminal)).toBe(2);
    const declined = await runSetup(
      setupInput(
        fakeTools(),
        {
          ask: (q) => {
            questions.push(q);
            return Promise.resolve(false);
          },
        },
        {},
      ),
    );
    expect(declined.stopped).toBe("licences not accepted; nothing was changed");
    expect(questions[0]).toContain("These licences apply:");
    questions.length = 0;
    const tools = fakeTools();
    const partly = await runSetup(
      setupInput(
        tools,
        {
          ask: (q) => {
            questions.push(q);
            // Licences yes, the Android download no.
            return Promise.resolve(!q.includes("for android"));
          },
        },
        { skip: ["appium", "uiautomator2"] },
      ),
    );
    expect(questions.filter((q) => q.startsWith("Download about"))).toEqual([
      expect.stringMatching(
        /^Download about 190 MB for java from https:\/\/github\.com\/adoptium\/temurin17-binaries\/releases\/download\/jdk\//,
      ),
      expect.stringMatching(/^Download about \d+ MB for android from /),
    ]);
    expect(partly.results.find((r) => r.tool === "android")).toMatchObject({
      status: "skipped",
      next: "qj setup --only android",
    });
    expect(tools.calls.some((c) => c.cmd.endsWith("sdkmanager"))).toBe(false);
  });

  it("REQ-GEN-06/AC6: a download that does not match its published checksum is deleted and never used", async () => {
    const tools = fakeTools({ served: { [artifacts().java.url]: "tampered archive" } });
    const input = setupInput(tools, {}, { yes: true, only: ["java"] });
    const report = await runSetup(input);
    expect(report.results).toEqual([
      expect.objectContaining({ tool: "java", status: "failed", next: "qj setup --only java" }),
    ]);
    expect(report.results[0]?.detail).toContain("does not match its published sha256 checksum");
    expect(tools.calls.some((c) => c.cmd === "tar")).toBe(false);
    expect(existsSync(join(input.root, ".downloads", "OpenJDK17U-jdk.tar.gz.part"))).toBe(false);
    expect((await readToolchainRecord(input.root)).tools).toEqual([]);
    expect(setupExitCode(report)).toBe(1);
  });

  it("REQ-GEN-06/AC6: when the emulator cannot run here, setup stops before downloading anything", async () => {
    const tools = fakeTools();
    const input = setupInput(tools);
    const noHvf = await runSetup({
      ...input,
      ports: { ...input.ports, exec: (cmd) => Promise.resolve(cmd === "sysctl" ? "0" : "ok") },
    });
    expect(noHvf.stopped).toContain("virtualisation: Hypervisor.framework (HVF) is not available");
    expect(noHvf.stopped).toContain("device farm");
    expect(tools.calls).toEqual([]);
    const lowDisk = await runSetup({
      ...input,
      ports: { ...input.ports, freeBytes: () => Promise.resolve(1024 ** 3) },
    });
    expect(lowDisk.stopped).toContain("disk:");
    expect(tools.calls).toEqual([]);
  });

  it("REQ-GEN-06/AC6: an ignored precheck is reported and does not stop setup; acceleration is then not checked", async () => {
    const tools = fakeTools();
    const input = setupInput(
      tools,
      {},
      { yes: true, skip: ["appium", "uiautomator2"], ignoreChecks: ["virtualisation"] },
    );
    const report = await runSetup({
      ...input,
      ports: { ...input.ports, exec: (cmd) => Promise.resolve(cmd === "sysctl" ? "0" : "ok") },
    });
    expect(report.stopped).toBeUndefined();
    expect(report.prechecks.find((p) => p.name === "virtualisation")?.detail).toContain(
      "(ignored: --ignore-check virtualisation)",
    );
    expect(report.results.find((r) => r.tool === "android")).toMatchObject({
      status: "ready",
      detail: expect.stringContaining("acceleration not checked (--ignore-check virtualisation)") as unknown,
    });
    expect(tools.calls.some((c) => c.args.includes("-accel-check"))).toBe(false);
  });

  it("REQ-GEN-06/AC6: two setups cannot run at once", async () => {
    const input = setupInput(fakeTools());
    await mkdir(input.root, { recursive: true });
    // The lock of a running process (this one) is respected.
    await writeFile(join(input.root, ".setup.lock"), `${String(process.ppid)}\n`);
    await expect(runSetup(input)).rejects.toMatchObject({ code: "TOOLCHAIN_LOCKED" });
    // A lock left by a process that is gone is taken over.
    await writeFile(join(input.root, ".setup.lock"), "999999999\n");
    expect((await runSetup(input)).stopped).toBeUndefined();
  });

  it("REQ-GEN-06/AC8: a tool that fails its smoke test is recorded unverified and never reported ready", async () => {
    const input = setupInput(fakeTools({ javaRuns: false }), {}, { yes: true, only: ["java"] });
    const report = await runSetup(input);
    expect(report.results).toEqual([
      expect.objectContaining({ tool: "java", status: "failed", next: "qj setup --reinstall java" }),
    ]);
    expect((await readToolchainRecord(input.root)).tools[0]?.verified).toBe(false);
    expect((await readToolchainChoice(join(dir, "project")))?.tools.java).toBeUndefined();
  });

  it("REQ-GEN-06/AC1: another Java major comes from Adoptium with its published checksum", async () => {
    const tools = fakeTools();
    const input = setupInput(tools, {}, { yes: true, only: ["java"], versions: { java: "21" } });
    const report = await runSetup(input);
    expect(report.results[0]).toMatchObject({ tool: "java", status: "ready" });
    const record = await readToolchainRecord(input.root);
    expect(record.tools[0]).toMatchObject({
      version: "21.0.4+7",
      checksum: `sha256:${sha("sha256", "jdk21")}`,
    });
  });

  it("REQ-GEN-06/AC7: mirrors, proxy and company CA reach every download; the npm token is never written", async () => {
    const ca = join(dir, "company-ca.pem");
    await writeFile(ca, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
    const tools = fakeTools({
      served: {
        "https://mirror.example.test/adoptium/temurin17-binaries/releases/download/jdk/OpenJDK17U-jdk.tar.gz":
          JDK,
      },
    });
    const input = setupInput(
      tools,
      { resolveSecret: () => Promise.resolve("npm-secret-token") },
      { yes: true, only: ["java", "appium"] },
      {
        sources: {
          java_mirror: "https://mirror.example.test/adoptium",
          npm_registry: "https://npm.example.test/repo/",
          npm_token: "secret://env/NPM_TOKEN",
        },
        network: { proxy: "http://proxy.example.test:3128", no_proxy: ["localhost"], ca_certs: ca },
      },
    );
    const report = await runSetup(input);
    expect(report.results.map((r) => r.status)).toEqual(["ready", "ready"]);
    const curl = tools.calls.find((c) => c.cmd === "curl");
    expect(curl?.args.at(-1)).toBe(
      "https://mirror.example.test/adoptium/temurin17-binaries/releases/download/jdk/OpenJDK17U-jdk.tar.gz",
    );
    expect(curl?.args.join(" ")).toContain("--proxy http://proxy.example.test:3128");
    expect(curl?.args.join(" ")).toContain(`--cacert ${join(input.root, "ca-bundle.pem")}`);
    // The company CA is trusted by QAJitsu's Java.
    expect(tools.calls.find((c) => c.cmd.endsWith("keytool"))?.args).toContain("-cacerts");
    const npm = tools.calls.find((c) => c.cmd === "npm");
    expect(npm?.env).toMatchObject({
      npm_config_registry: "https://npm.example.test/repo/",
      npm_config_https_proxy: "http://proxy.example.test:3128",
      QJ_NPM_TOKEN: "npm-secret-token",
      HOMEBREW_NO_ANALYTICS: "1",
    });
    const npmrc = await readFile(npm?.env["npm_config_userconfig"] ?? "", "utf8");
    expect(npmrc).toBe(
      "registry=https://npm.example.test/repo/\n//npm.example.test/repo/:_authToken=${QJ_NPM_TOKEN}\n",
    );
    expect(npm?.args.join(" ")).not.toContain("npm-secret-token");
  });

  it("REQ-GEN-06/AC5: uninstall removes only what QAJitsu installed, never Docker or a path outside the toolchain", async () => {
    const input = setupInput(fakeTools(), {}, { yes: true, only: ["java"] });
    await runSetup(input);
    const javaDir = join(input.root, "java", "17.0.20.1+1");
    expect(existsSync(javaDir)).toBe(true);
    const base = { source: "x", licence: "x", installed_at: "x", parts: [], verified: true };
    await recordInstalled(input.root, {
      ...base,
      tool: "docker",
      version: "colima",
      path: "/opt/homebrew/bin/colima",
      system: true,
    });
    await recordInstalled(input.root, {
      ...base,
      tool: "appium",
      version: "3.8.0",
      path: "/usr/local/lib",
      system: false,
    });
    const ports = { run: fakeTools().run, node: "node", playwrightCli: "cli.js", log: () => undefined };
    const report = await uninstallTools(input.root, ["java", "docker", "appium", "xcode"], ports);
    expect(report.removed.map((e) => e.tool)).toEqual(["java"]);
    expect(report.kept.map((k) => [k.entry.tool, k.reason])).toEqual([
      ["docker", "system-wide: QAJitsu installs it once and never removes it"],
      ["appium", `/usr/local/lib is outside ${input.root}; refused`],
    ]);
    expect(report.notInstalled).toEqual(["xcode"]);
    expect(existsSync(javaDir)).toBe(false);
    expect((await readToolchainRecord(input.root)).tools.map((t) => t.tool)).toEqual(["docker", "appium"]);
  });

  it("REQ-GEN-06/AC7: --download makes a bundle; --from installs it on an offline machine after checking it", async () => {
    const bundle = join(dir, "bundle");
    const online = setupInput(
      fakeTools(),
      {},
      { yes: true, skip: ["appium", "uiautomator2"] },
      {},
      join(bundle, "toolchain"),
    );
    const made = await runSetup({ ...online, bundle, projectHome: undefined });
    expect(made.results.map((r) => [r.tool, r.status])).toEqual([
      ["java", "ready"],
      ["android", "ready"],
    ]);
    const manifest = JSON.parse(await readFile(join(bundle, "bundle.json"), "utf8")) as {
      host: unknown;
      tools: { tool: string; folder: string }[];
    };
    expect(manifest.host).toEqual({ os: "darwin", arch: "arm64" });
    expect(manifest.tools.map((t) => [t.tool, t.folder])).toEqual([
      ["java", "java/17.0.20.1+1"],
      ["android", "android/sdk"],
    ]);
    // The offline machine: no network at all.
    const offline = fakeTools({ offline: true });
    const target = setupInput(offline, {}, { yes: true, skip: ["appium", "uiautomator2"] });
    const installed = await runSetupFromBundle(target, bundle);
    expect(installed.results.map((r) => [r.tool, r.status])).toEqual([
      ["java", "ready"],
      ["android", "ready"],
    ]);
    expect(offline.calls.some((c) => c.cmd === "curl")).toBe(false);
    // The AVD is created on this machine, against this machine's SDK.
    expect(existsSync(join(target.root, "android", "avd", "qj.avd"))).toBe(true);
    const record = await readToolchainRecord(target.root);
    expect(record.tools.find((t) => t.tool === "java")).toMatchObject({
      path: join(target.root, "java", "17.0.20.1+1", "Contents", "Home"),
      source: `bundle:${bundle}`,
      verified: true,
    });
    // A changed file in the bundle is refused before anything of it is used.
    await writeFile(
      join(bundle, "toolchain", "java", "17.0.20.1+1", "Contents", "Home", "bin", "java"),
      "evil",
    );
    const other = setupInput(
      fakeTools({ offline: true }),
      {},
      { yes: true, only: ["java"] },
      {},
      join(dir, "other"),
    );
    await expect(runSetupFromBundle(other, bundle)).rejects.toMatchObject({ code: "BUNDLE_DIGEST_MISMATCH" });
    expect(existsSync(join(dir, "other", "java", "17.0.20.1+1"))).toBe(false);
    const linux = setupInput(
      fakeTools(),
      { host: { os: "linux", arch: "x64" } },
      { yes: true },
      {},
      join(dir, "l"),
    );
    await expect(runSetupFromBundle(linux, bundle)).rejects.toMatchObject({ code: "BUNDLE_HOST_MISMATCH" });
  });
});
