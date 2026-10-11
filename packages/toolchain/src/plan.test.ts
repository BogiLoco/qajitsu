import { parseProjectConfig } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { ToolchainFileSchema, type ToolchainFile } from "./config.js";
import { detectToolchain, sdkPackagePath, userEnv, type DetectPorts, type ProbeExec } from "./detect.js";
import { JAVA_ARTIFACTS, JAVA_RELEASE, type Host } from "./manifest.js";
import { toolchainNeeds } from "./needs.js";
import { changingSteps, managedAppiumHome, planSetup, type PlanOptions, type PlanStep } from "./plan.js";
import type { InstalledTool, ToolchainRecord } from "./registry.js";

const ROOT = "/home/u/.qajitsu/toolchain";
const mac: Host = { os: "darwin", arch: "arm64" };

const config = (yaml: Record<string, unknown> = {}) =>
  parseProjectConfig({
    project: "shop",
    jira: { type: "file", tickets_dir: "t", project_key: "SHOP" },
    ...yaml,
  });

const mobileProject = (android: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  config({
    test_types: ["api", "web", "mobile"],
    web: { browser: "chromium", matrix: { browsers: ["chromium", "firefox"] } },
    services: { db: { kind: "compose", port: 5432 } },
    mobile: {
      android: {
        app: { source: "build", repo: "shop", command: ["./gradlew", "assembleDebug"], output: "a.apk" },
        app_id: "a.b",
        emulator: { avd: "qj", system_image: "system-images;android-34;google_apis;arm64-v8a" },
        ...android,
      },
      ...extra,
    },
  });

/** A machine: answers of tools by "cmd args", files that exist, browsers installed. */
function machine(
  answers: Record<string, string> = {},
  files: string[] = [],
  browsers: Record<string, boolean> = {},
  env: Record<string, string> = { PATH: "/usr/bin" },
): DetectPorts {
  const exec: ProbeExec = (cmd, args) => Promise.resolve(answers[`${cmd} ${args.join(" ")}`]);
  return {
    exec,
    exists: (p) => files.some((f) => f === p || f.startsWith(`${p}/`)),
    env,
    home: "/home/u",
    host: mac,
    browsers: () =>
      ["chromium", "firefox", "webkit"].map((name) => ({
        name,
        version: "1",
        installed: browsers[name] === true,
      })),
  };
}

const SDK = "/home/u/Library/Android/sdk";
const fullSdk = [
  "cmdline-tools;latest",
  "platform-tools",
  "platforms;android-34",
  "build-tools;34.0.0",
  "emulator",
  "system-images;android-34;google_apis;arm64-v8a",
].map((p) => sdkPackagePath(SDK, p));

const good = {
  "java -version": 'openjdk version "17.0.12" 2024-07-16',
  "appium --version": "3.8.0",
  "appium driver list --installed --json": '{"uiautomator2":{"version":"8.7.0"}}',
  "docker version --format {{.Client.Version}}": "27.3.1",
  "docker version --format {{.Server.Version}}": "27.3.1",
  "docker compose version --short": "v2.29.1",
};

const entry = (
  tool: InstalledTool["tool"],
  version: string,
  path: string,
  parts: string[] = [],
): InstalledTool => ({
  tool,
  version,
  path,
  source: "test",
  licence: "test",
  installed_at: "2026-10-09T00:00:00.000Z",
  parts,
  verified: true,
  system: false,
});

async function plan(
  ports: DetectPorts,
  options: PlanOptions = {},
  record: ToolchainRecord = { schema: 1, tools: [] },
  file: Partial<ToolchainFile> = {},
  project = mobileProject(),
): Promise<Record<string, PlanStep>> {
  const cfg = ToolchainFileSchema.parse(file);
  const needs = toolchainNeeds(project, cfg.versions);
  const withRecord: DetectPorts = {
    ...ports,
    exists: (p) => ports.exists(p) || record.tools.some((t) => t.path === p),
  };
  const detected = await detectToolchain(needs, record, withRecord);
  const steps = planSetup({ needs, detected, host: ports.host, root: ROOT, config: cfg, options });
  return Object.fromEntries(steps.map((s) => [s.tool, s]));
}

describe("what a project needs (REQ-GEN-06/AC1)", () => {
  it("REQ-GEN-06/AC1: derives tools, browsers and Android packages from .qa/", () => {
    const needs = toolchainNeeds(mobileProject(), { android: { platform: 35, build_tools: "35.0.0" } });
    expect([...needs.tools.keys()].sort()).toEqual([
      "android",
      "appium",
      "browsers",
      "docker",
      "java",
      "uiautomator2",
    ]);
    expect(needs.browsers).toEqual(["chromium", "firefox"]);
    expect(needs.android).toEqual({
      packages: [
        "platform-tools",
        "platforms;android-35",
        "build-tools;35.0.0",
        "emulator",
        "system-images;android-34;google_apis;arm64-v8a",
      ],
      emulators: [{ systemImage: "system-images;android-34;google_apis;arm64-v8a", avd: "qj" }],
      atOnce: 1,
    });
  });

  it("REQ-EXEC-20/AC5: several emulators need each system image once and one AVD each, with its hardware profile", () => {
    const needs = toolchainNeeds(
      mobileProject({
        app: { source: "path", repo: "shop", path: "a.apk" },
        emulator: undefined,
        emulators: [
          {
            name: "pixel",
            avd: "qj-pixel",
            system_image: "system-images;android-34;google_apis;arm64-v8a",
            device: "pixel_8",
          },
          {
            name: "tablet",
            avd: "qj-tablet",
            system_image: "system-images;android-34;google_apis;arm64-v8a",
            device: "pixel_tablet",
          },
          { name: "old", avd: "qj-old", system_image: "system-images;android-30;google_apis;arm64-v8a" },
        ],
      }),
      {},
    );
    expect(needs.android).toEqual({
      packages: [
        "platform-tools",
        "emulator",
        "system-images;android-34;google_apis;arm64-v8a",
        "system-images;android-30;google_apis;arm64-v8a",
      ],
      emulators: [
        { avd: "qj-pixel", systemImage: "system-images;android-34;google_apis;arm64-v8a", device: "pixel_8" },
        {
          avd: "qj-tablet",
          systemImage: "system-images;android-34;google_apis;arm64-v8a",
          device: "pixel_tablet",
        },
        { avd: "qj-old", systemImage: "system-images;android-30;google_apis;arm64-v8a" },
      ],
      atOnce: 3,
    });
  });

  it("REQ-GEN-06/AC1: an API-only project needs nothing; a remote Appium needs no local Appium; iOS needs Xcode", () => {
    expect(toolchainNeeds(config(), {}).tools.size).toBe(0);
    const remote = toolchainNeeds(
      config({
        test_types: ["mobile"],
        mobile: {
          appium: { url: "http://farm.example.test:4723" },
          android: { app: { source: "path", repo: "shop", path: "a.apk" }, app_id: "a.b" },
        },
      }),
      {},
    );
    expect([...remote.tools.keys()].sort()).toEqual(["android", "java"]);
    expect(remote.android?.packages).toEqual(["platform-tools"]);
    const ios = toolchainNeeds(config({ test_types: ["mobile"], mobile: { ios: { bundle_id: "a.b" } } }), {});
    expect([...ios.tools.keys()].sort()).toEqual(["appium", "xcode", "xcuitest"]);
  });
});

describe("the setup plan (REQ-GEN-06/AC1, AC2, AC4, AC5)", () => {
  it("REQ-GEN-06/AC1: a bare machine gets every needed tool at the pinned version, from where, how big", async () => {
    const p = await plan(machine());
    expect(p["java"]).toMatchObject({
      action: "install",
      version: JAVA_RELEASE,
      source: JAVA_ARTIFACTS["darwin-arm64"].url,
      bytes: JAVA_ARTIFACTS["darwin-arm64"].size,
      reason: "not found",
    });
    expect(p["android"]).toMatchObject({
      action: "install",
      parts: [
        "platform-tools",
        "platforms;android-34",
        "build-tools;34.0.0",
        "emulator",
        "system-images;android-34;google_apis;arm64-v8a",
        "avd:qj",
      ],
    });
    expect(p["android"]?.bytes).toBeGreaterThan(2_000_000_000);
    expect(p["appium"]).toMatchObject({ action: "install", version: "3.8.0", source: "npm: appium@3.8.0" });
    expect(p["uiautomator2"]).toMatchObject({
      action: "install",
      version: "8.7.0",
      path: managedAppiumHome(ROOT),
    });
    expect(p["browsers"]).toMatchObject({ action: "install", parts: ["chromium", "firefox"] });
    expect(p["docker"]).toMatchObject({
      action: "install",
      source: "Homebrew: colima docker docker-compose",
    });
    expect(p["xcuitest"]?.action).toBe("skip");
    expect(p["xcode"]).toMatchObject({ action: "skip", reason: "not needed by this project" });
    expect(Object.values(p).every((s) => s.licence.length > 0)).toBe(true);
  });

  it("REQ-GEN-06/AC2: compatible tools on the machine are used as they are; nothing is installed", async () => {
    const p = await plan(machine(good, fullSdk, { chromium: true, firefox: true }));
    expect(changingSteps(Object.values(p))).toEqual([]);
    expect(p["java"]).toMatchObject({ action: "use-system", version: "17.0.12", path: "PATH" });
    expect(p["android"]).toMatchObject({ action: "use-system", path: SDK });
    expect(p["appium"]?.action).toBe("use-system");
    expect(p["uiautomator2"]?.action).toBe("use-system");
    expect(p["docker"]?.action).toBe("use-system");
    expect(p["browsers"]?.action).toBe("use-system");
  });

  it("REQ-GEN-06/AC2: an incompatible tool is never changed: a compatible one goes next to it", async () => {
    const p = await plan(
      machine(
        {
          ...good,
          "java -version": 'java version "1.8.0_392"',
          "appium --version": "2.11.5",
          "appium driver list --installed --json": '{"uiautomator2":{"version":"3.8.0"}}',
          "docker version --format {{.Server.Version}}": "20.10.7",
          "docker version --format {{.Client.Version}}": "20.10.7",
        },
        fullSdk.filter((f) => !f.includes("build-tools")),
      ),
    );
    expect(p["java"]).toMatchObject({ action: "install", version: JAVA_RELEASE });
    expect(p["java"]?.reason).toContain("yours (1.8.0_392, PATH) is not compatible (needs >=17)");
    expect(p["java"]?.reason).toContain("never changes yours");
    expect(p["android"]?.action).toBe("install");
    expect(p["android"]?.reason).toContain("lacks build-tools;34.0.0");
    expect(p["appium"]?.reason).toContain("needs >=3.0.0 <4.0.0");
    expect(p["uiautomator2"]).toMatchObject({ action: "install", path: managedAppiumHome(ROOT) });
    // Docker is system-wide: QAJitsu tells the user and never changes it.
    expect(p["docker"]).toMatchObject({ action: "manual" });
    expect(p["docker"]?.reason).toContain("needs Docker >=24 with Compose v2");
  });

  it("REQ-GEN-06/AC2: Docker installed but stopped is started; a missing Compose is incompatible", async () => {
    const stopped = await plan(machine({ ...good, "docker version --format {{.Server.Version}}": "" }));
    expect(stopped["docker"]).toMatchObject({ action: "start", source: "colima start" });
    const noCompose = await plan(machine({ ...good, "docker compose version --short": "" }));
    expect(noCompose["docker"]?.action).toBe("manual");
  });

  it("REQ-GEN-06/AC1: .qa/toolchain.yaml pins other versions; the user's tool is used only when it matches", async () => {
    const p = await plan(
      machine(good, fullSdk),
      {},
      { schema: 1, tools: [] },
      {
        versions: { java: "21", appium: "3.7.0" },
      },
    );
    expect(p["java"]).toMatchObject({ action: "install", version: "21" });
    expect(p["java"]?.source).toContain("api.adoptium.net");
    expect(p["java"]?.reason).toContain("not the version the project pins (21)");
    expect(p["appium"]).toMatchObject({ action: "install", version: "3.7.0" });
    const ok = await plan(
      machine({ ...good, "java -version": 'openjdk version "21.0.4"' }, fullSdk),
      {},
      { schema: 1, tools: [] },
      { versions: { java: "21" } },
    );
    expect(ok["java"]?.action).toBe("use-system");
  });

  it("REQ-GEN-06/AC3: copies QAJitsu installed are used; the SDK only gets the packages it lacks", async () => {
    const java = entry("java", JAVA_RELEASE, `${ROOT}/java/${JAVA_RELEASE}/Contents/Home`);
    const sdk = entry("android", "sdk", `${ROOT}/android/sdk`, ["platform-tools", "avd:qj"]);
    const p = await plan(machine(), {}, { schema: 1, tools: [java, sdk] });
    expect(p["java"]).toMatchObject({ action: "use-managed", path: java.path });
    expect(p["android"]).toMatchObject({
      action: "install",
      path: sdk.path,
      source: "sdkmanager",
      parts: [
        "platforms;android-34",
        "build-tools;34.0.0",
        "emulator",
        "system-images;android-34;google_apis;arm64-v8a",
      ],
    });
    expect(p["android"]?.reason).toContain("QAJitsu's SDK lacks");
  });

  it("REQ-GEN-06/AC4: --only and --skip choose the parts", async () => {
    const only = await plan(machine(), { only: ["java", "xcode"] });
    expect(
      Object.values(only)
        .filter((s) => s.action !== "skip")
        .map((s) => s.tool),
    ).toEqual(["java", "xcode"]);
    expect(only["docker"]?.reason).toBe("not in --only");
    const skip = await plan(machine(), { skip: ["android", "docker"] });
    expect(skip["android"]).toMatchObject({ action: "skip", reason: "--skip" });
    expect(skip["java"]?.action).toBe("install");
  });

  it("REQ-GEN-06/AC5: --reinstall works only on what QAJitsu installed; --version installs next to it", async () => {
    const none = await plan(machine(good, fullSdk), { reinstall: ["java", "android", "docker"] });
    expect(none["java"]).toMatchObject({ action: "unsupported" });
    expect(none["java"]?.reason).toContain("QAJitsu did not install java");
    expect(none["android"]?.action).toBe("unsupported");
    expect(none["docker"]?.reason).toContain("system-wide");
    const java = entry("java", JAVA_RELEASE, `${ROOT}/java/x/Contents/Home`);
    const again = await plan(machine(), { reinstall: ["java"] }, { schema: 1, tools: [java] });
    expect(again["java"]).toMatchObject({ action: "reinstall", version: JAVA_RELEASE, path: java.path });
    const other = await plan(machine(good, fullSdk), { versions: { java: "21", uiautomator2: "8.6.0" } });
    expect(other["java"]).toMatchObject({
      action: "install",
      version: "21",
      reason:
        "yours (17.0.12, PATH) is not the version the project pins (21); QAJitsu installs one next to it and never changes yours",
    });
    expect(other["uiautomator2"]).toMatchObject({ action: "install", version: "8.6.0" });
    const pinnedBrowsers = await plan(machine(), { versions: { browsers: "1.0" } });
    expect(pinnedBrowsers["browsers"]?.action).toBe("unsupported");
  });

  it("REQ-GEN-06/AC2: drivers share one Appium home: one missing driver moves both into QAJitsu's", async () => {
    const both = mobileProject({}, { ios: { bundle_id: "a.b" } });
    const p = await plan(machine(good, fullSdk), {}, { schema: 1, tools: [] }, {}, both);
    expect(p["uiautomator2"]).toMatchObject({ action: "install", path: managedAppiumHome(ROOT) });
    expect(p["xcuitest"]).toMatchObject({ action: "install", version: "12.16.0" });
    expect(p["xcode"]?.action).toBe("install");
  });

  it("REQ-GEN-06/AC1: local iOS on Linux is not possible: it points to a device farm", async () => {
    const linux = { ...machine(), host: { os: "linux", arch: "x64" } as const };
    const p = await plan(
      linux,
      {},
      { schema: 1, tools: [] },
      {},
      config({ test_types: ["mobile"], mobile: { ios: { bundle_id: "a.b" } } }),
    );
    expect(p["xcode"]).toMatchObject({ action: "unsupported" });
    expect(p["xcode"]?.reason).toContain("mobile.ios.farm");
    expect(p["docker"]?.action).toBe("skip");
  });

  it("REQ-GEN-06/AC2: a managed tool is never mistaken for the user's own", () => {
    const env = userEnv(
      {
        PATH: `${ROOT}/java/x/bin:/usr/bin:${ROOT}/android/sdk/platform-tools`,
        JAVA_HOME: `${ROOT}/java/x`,
        ANDROID_HOME: "/opt/android",
        APPIUM_HOME: `${ROOT}/appium-home/3`,
      },
      ROOT,
    );
    expect(env).toEqual({ PATH: "/usr/bin", ANDROID_HOME: "/opt/android" });
  });
});
