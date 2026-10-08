import { describe, expect, it } from "vitest";
import { parseProjectConfig } from "@qajitsu/core";
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
    expect(by["firefox"]?.install).toBe("pnpm --filter @qajitsu/cli exec playwright-core install firefox");
    expect(by["webkit"]).toMatchObject({ version: undefined, needed: false });
    expect(by["java"]).toMatchObject({ version: "17.0.12", needed: true });
    expect(by["android sdk"]).toMatchObject({ version: undefined, needed: true });
    expect(by["emulator"]).toMatchObject({ version: undefined, needed: true });
    expect(by["appium"]).toMatchObject({ version: "2.11.5", needed: true });
    expect(by["appium uiautomator2"]).toMatchObject({ version: "3.8.0", needed: true });
    const text = formatToolVersions(tools);
    expect(text).toMatch(/✔ git +2\.45\.1/);
    expect(text).toMatch(/✘ firefox +not found \(needed for web tests\); install: pnpm --filter/);
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
      install: "appium driver install xcuitest",
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

  it("reads Playwright and the QAJitsu version of this installation", () => {
    expect(qajitsuVersion()).toMatch(/^\d+\.\d+\.\d+/);
    const pw = playwrightInfo();
    expect(pw.version).toMatch(/^\d+\.\d+/);
    expect(pw.browsers.map((b) => b.name)).toEqual(["chromium", "firefox", "webkit"]);
  });
});
