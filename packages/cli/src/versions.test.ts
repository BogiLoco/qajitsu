import { describe, expect, it } from "vitest";
import { parseProjectConfig } from "@qajitsu/core";
import { channelExecutables } from "@qajitsu/adapter-runner-web";
import type { LoadedProject } from "./project.js";
import {
  formatToolVersions,
  playwrightInfo,
  qajitsuVersion,
  runVersions,
  toolVersions,
  versionRecord,
  type VersionExec,
} from "./versions.js";

/** Answers like the real tools; `missing` tools are not installed. */
const fakeExec =
  (missing: string[] = []): VersionExec =>
  (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    if (missing.some((m) => key.startsWith(m))) return Promise.resolve(undefined);
    const answers: Record<string, string> = {
      "sw_vers -productVersion": "14.5",
      "git --version": "git version 2.45.1",
      "docker version --format {{.Server.Version}}": "27.3.1",
      "docker compose version --short": "v2.29.1",
      "java -version": 'openjdk version "17.0.12" 2024-07-16\nOpenJDK Runtime Environment',
      "appium --version": "2.11.5",
      "appium driver list --installed --json":
        '- Listing installed drivers\n{"uiautomator2":{"version":"3.8.0"}}',
      "xcodebuild -version": "Xcode 16.0\nBuild version 16A242d",
    };
    return Promise.resolve(answers[key]);
  };
const playwright = () => ({
  version: "1.63.0",
  browsers: [
    { name: "chromium", version: "153.0", installed: true },
    { name: "firefox", version: "155.0", installed: false },
    { name: "webkit", version: "26.6", installed: false },
  ],
});
const project = (yaml: Record<string, unknown>): LoadedProject => ({
  qaDir: "/repo/.qa",
  projectDir: "/repo",
  config: parseProjectConfig({
    project: "shop",
    jira: { type: "file", tickets_dir: "t", project_key: "SHOP" },
    ...yaml,
  }),
});

describe("tool versions (REQ-GEN-03/AC4)", () => {
  it("REQ-EXEC-66/AC2: a channel of the matrix is listed with the version the browser reports; a missing one says how to install it", async () => {
    const chrome = channelExecutables("chrome")[0] ?? "";
    const tools = await toolVersions({
      qajitsu: "0.4.0",
      node: "v22.12.0",
      project: project({
        test_types: ["web"],
        web: { browser: "chromium", matrix: { browsers: ["chromium", "chrome", "msedge"] } },
      }),
      exec: (cmd, args) =>
        Promise.resolve(
          cmd === chrome && args[0] === "--version" ? "Google Chrome 141.0.7390.54" : undefined,
        ),
      exists: (p) => p === chrome,
      playwright: () => ({
        version: "1.63.0",
        browsers: [
          { name: "chromium", version: "153.0", installed: true },
          { name: "chrome", installed: true },
          { name: "msedge", installed: false },
          { name: "chrome-beta", installed: false },
        ],
      }),
    });
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(by["chrome"]).toMatchObject({ version: "141.0.7390.54", needed: true });
    expect(by["msedge"]).toMatchObject({ needed: true, install: "qj setup --only browsers" });
    expect(by["msedge"]?.version).toBeUndefined();
    // A channel nobody uses and nobody installed is not listed.
    expect(by["chrome-beta"]).toBeUndefined();
  });

  it("REQ-GEN-03/AC4: reads every tool's version and marks what the project needs", async () => {
    const tools = await toolVersions({
      qajitsu: "0.4.0",
      node: "v22.12.0",
      project: project({
        test_types: ["api", "web", "mobile"],
        web: { browser: "chromium", matrix: { browsers: ["chromium", "firefox"] } },
        services: { db: { kind: "compose", port: 5432 } },
        mobile: {
          android: {
            app: { source: "path", repo: "shop", path: "a.apk" },
            app_id: "a.b",
            sdk_root: "/nonexistent/sdk",
            emulator: { avd: "x", system_image: "system-images;android-34;google_apis;arm64-v8a" },
          },
        },
      }),
      exec: fakeExec(),
      playwright,
    });
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(by["qajitsu"]).toMatchObject({ version: "0.4.0", needed: true });
    expect(by["git"]?.version).toBe("2.45.1");
    expect(by["docker"]).toMatchObject({ version: "27.3.1", needed: true });
    expect(by["compose"]).toMatchObject({ version: "2.29.1", needed: true });
    expect(by["playwright"]).toMatchObject({ version: "1.63.0", needed: true });
    expect(by["chromium"]).toMatchObject({ version: "153.0", needed: true });
    // Firefox is in the matrix but not installed: needed and missing, with the install command.
    expect(by["firefox"]).toMatchObject({ version: undefined, needed: true });
    expect(by["firefox"]?.install).toBe("qj setup --only browsers");
    expect(by["webkit"]).toMatchObject({ version: undefined, needed: false });
    expect(by["java"]).toMatchObject({ version: "17.0.12", needed: true });
    expect(by["android sdk"]).toMatchObject({ version: undefined, needed: true });
    expect(by["emulator"]).toMatchObject({ version: undefined, needed: true });
    expect(by["appium"]).toMatchObject({ version: "2.11.5", needed: true });
    expect(by["appium uiautomator2"]).toMatchObject({ version: "3.8.0", needed: true });
    const text = formatToolVersions(tools);
    expect(text).toMatch(/✔ git +2\.45\.1/);
    expect(text).toMatch(/✘ firefox +not found \(needed for web tests\); install: qj setup --only browsers/);
    expect(text).toMatch(/· webkit +not found \(not needed by this project\)/);
  });

  it("REQ-GEN-03/AC4 + REQ-OBS-10/AC4: without a project only the basics are needed; a missing version is unknown", async () => {
    const tools = await toolVersions({
      qajitsu: "0.4.0",
      node: "v22.12.0",
      exec: fakeExec(["git", "docker", "java"]),
      playwright,
    });
    expect(tools.filter((t) => t.needed).map((t) => t.name)).toEqual(["qajitsu", "os", "node", "git"]);
    expect(versionRecord(tools)["git"]).toBe("unknown");
    expect(formatToolVersions(tools)).toMatch(
      /✘ git +not found \(needed for fetching the change\); install: install git/,
    );
  });

  it("REQ-GEN-03/AC4: an iOS project without a farm needs Xcode and the XCUITest driver", async () => {
    const tools = await toolVersions({
      qajitsu: "0.4.0",
      node: "v22.12.0",
      project: project({
        mobile: { ios: { app: { source: "path", repo: "shop", path: "a.app" }, bundle_id: "a.b" } },
      }),
      exec: fakeExec(),
      playwright,
    });
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(by["xcode"]).toMatchObject({ version: "16.0", needed: true });
    expect(by["appium xcuitest"]).toMatchObject({
      version: undefined,
      needed: true,
      install: "qj setup --only xcuitest",
    });
  });

  it("REQ-OBS-10/AC1: a run records QAJitsu, the basics, what the project needs and the model of each role", async () => {
    const record = await runVersions(
      project({
        test_types: ["web"],
        models: {
          providers: { local: { type: "ollama", base_url: "http://localhost:11434" } },
          roles: { default: "local/qwen3:32b", auditor: "local/llama3" },
        },
      }),
      { exec: fakeExec(), playwright },
    );
    expect(record).toMatchObject({
      qajitsu: qajitsuVersion(),
      node: process.version,
      git: "2.45.1",
      playwright: "1.63.0",
      chromium: "153.0",
      "model default": "local/qwen3:32b",
      "model auditor": "local/llama3",
    });
    expect(record["docker"]).toBeUndefined();
    expect(record["firefox"]).toBeUndefined();
  });

  it("REQ-GEN-09/AC4: a run in the QAJitsu image records the image by digest, never by its tag alone", async () => {
    const tools = (env: Record<string, string | undefined>) =>
      toolVersions({ qajitsu: "0.1.0", node: "v22.12.0", exec: fakeExec(), playwright, env });
    const ref = "ghcr.io/bogiloco/qajitsu:0.1.0";
    const digest = `sha256:${"a".repeat(64)}`;
    const image = async (env: Record<string, string | undefined>) =>
      (await tools(env)).find((t) => t.name === "qajitsu image");
    expect(await image({ QAJITSU_IMAGE: ref, QAJITSU_IMAGE_DIGEST: digest })).toEqual({
      name: "qajitsu image",
      version: `ghcr.io/bogiloco/qajitsu@${digest} (declared when the container was started, not verified)`,
      needed: true,
    });
    // Without the digest the record says so; a tag alone could point at another image tomorrow.
    expect(await image({ QAJITSU_IMAGE: ref })).toEqual({
      name: "qajitsu image",
      version: `${ref} (digest not given: run with -e QAJITSU_IMAGE_DIGEST)`,
      needed: true,
    });
    // A digest that is not a digest is not recorded as one.
    expect((await image({ QAJITSU_IMAGE: ref, QAJITSU_IMAGE_DIGEST: "latest" }))?.version).toContain(
      "digest not given",
    );
    // Outside the image there is no image line.
    expect(await image({})).toBeUndefined();
    const record = await runVersions(project({}), {
      exec: fakeExec(),
      playwright,
      env: { QAJITSU_IMAGE: ref, QAJITSU_IMAGE_DIGEST: digest },
    });
    expect(record["qajitsu image"]).toBe(
      `ghcr.io/bogiloco/qajitsu@${digest} (declared when the container was started, not verified)`,
    );
  });

  it("reads Playwright and the QAJitsu version of this installation", () => {
    expect(qajitsuVersion()).toMatch(/^\d+\.\d+\.\d+/);
    const pw = playwrightInfo();
    expect(pw.version).toMatch(/^\d+\.\d+/);
    expect(pw.browsers.map((b) => b.name)).toEqual([
      "chromium",
      "firefox",
      "webkit",
      "chrome",
      "chrome-beta",
      "msedge",
      "msedge-beta",
    ]);
  });
});
