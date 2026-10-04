// Stage 8 "done when" (docs/roadmap.md), Android: two suites in one file so they share the emulator image
// one after another (e2e files run in parallel). Skipped when no Android SDK image is installed.
// 1. Runner level: an emulator started by QAJitsu, the trusted parent drives the app through Appium; BUG-08
//    (back from checkout empties the cart) ends FAILED while the clean app PASSES, with a screenshot per step,
//    screen recording and device logs (REQ-EXEC-06, REQ-EVD-03, REQ-ENV-06/AC2, REQ-NFR-04).
// 2. Full flow: `qj run DEMO-6 --build` builds the app from the run's worktree, starts emulator and Appium,
//    runs the case in the real sandbox and stops everything (REQ-ENV-06/AC1+AC2).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPlaywrightTransport,
  createSandboxExecutor,
  executeAttempt,
  type AttemptInput,
} from "@qajitsu/adapter-runner-api";
import {
  androidSdkRoot,
  connectAppium,
  createAppiumDeviceFactory,
  startAndroidEmulator,
  startAppium,
  type RunningAppium,
  type RunningEmulator,
} from "@qajitsu/adapter-runner-mobile";
import { PlanSchema, readRunIndex, type TicketKey } from "@qajitsu/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { apiService, createBuildProject } from "../support/cli-build.js";
import { startShop } from "../../examples/demo-shop/api/server.mjs";

const sdk = androidSdkRoot();
const IMAGE = "system-images;android-34;google_apis;arm64-v8a";
const available = existsSync(join(sdk, "system-images", "android-34", "google_apis", "arm64-v8a"));
const root = fileURLToPath(new URL("../../", import.meta.url));
const apk = join(root, "examples/demo-shop/android/build/demo-shop.apk");
const PASSWORD = "fictional-demo-password";
const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-6",
  version: 1,
  ...JSON.parse(readFileSync(join(root, "fixtures/plans/demo-6-draft.json"), "utf8")),
});
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => {
        resolve(port);
      });
    });
  });

let emulator: RunningEmulator | undefined;
let appium: RunningAppium | undefined;

describe.skipIf(!available)("Android app on an emulator (stage 8)", () => {
  beforeAll(async () => {
    if (!existsSync(apk))
      execFileSync(process.execPath, [join(root, "examples/demo-shop/android/build.mjs")], {
        env: { ...process.env, JAVA_HOME: process.env["JAVA_HOME"] ?? "/opt/homebrew/opt/openjdk@17" },
      });
    emulator = await startAndroidEmulator({
      sdkRoot: sdk,
      avd: "qajitsu-e2e",
      systemImage: IMAGE,
      headless: true,
      bootTimeoutMs: 420_000,
    });
    appium = await startAppium({
      bin: join(root, "node_modules/.bin/appium"),
      port: await freePort(),
      env: {
        APPIUM_HOME: join(root, ".appium"),
        ANDROID_SDK_ROOT: sdk,
        ANDROID_HOME: sdk,
        JAVA_HOME: process.env["JAVA_HOME"] ?? "/opt/homebrew/opt/openjdk@17",
      },
      timeoutMs: 120_000,
    });
  }, 600_000);

  afterAll(async () => {
    await appium?.stop();
    await emulator?.stop();
  }, 120_000);

  const attempt = async (flag?: string) => {
    const shop = await startShop({ env: { DEMO_USER_PASSWORD: PASSWORD, ...(flag ? { [flag]: "1" } : {}) } });
    const port = new URL(shop.url).port;
    const device = createAppiumDeviceFactory({
      platform: "android",
      connect: (caps) => connectAppium(appium?.url ?? "", caps),
      capabilities: {
        platformName: "Android",
        "appium:automationName": "UiAutomator2",
        "appium:udid": emulator?.serial,
        "appium:app": apk,
        "appium:appPackage": "dev.qajitsu.demoshop",
        "appium:appActivity": ".CartActivity",
        "appium:optionalIntentArguments": `--es api_url http://10.0.2.2:${port}`,
        "appium:newCommandTimeout": 120,
      },
      deepLinkScheme: "demoshop",
      appId: "dev.qajitsu.demoshop",
    });
    const input: AttemptInput = {
      specFile: join(root, "fixtures/specs/demo-6/TC-01.spec.ts"),
      caseId: "TC-01",
      attempt: 1,
      plan,
      baseUrl: shop.url,
      allowedOrigins: [shop.url],
      accounts: {},
      secrets: [PASSWORD],
      timeoutMs: 180_000,
    };
    const { transport, dispose } = await createPlaywrightTransport({ timeoutMs: 5000 });
    try {
      return await executeAttempt(input, transport, Date.now, device);
    } finally {
      await dispose();
      await shop.close();
    }
  };

  it("REQ-EXEC-06/AC1 + REQ-EVD-03/AC1+AC3: the clean app PASSES with a screenshot per step and device logs", async () => {
    const record = await attempt();
    expect(record.error).toBeUndefined();
    expect(record.outcome).toBe("passed");
    expect(record.assertions.map((a) => [a.stepId, a.actual])).toEqual([
      ["S1", "Cart: 1 item"],
      ["S2", true],
      ["S3", "Cart: 1 item"],
    ]);
    expect(record.evidence.map((e) => e.name)).toEqual(["S1.png", "S2.png", "S3.png", "logcat.log"]);
  }, 300_000);

  it("REQ-NFR-04/AC1 + REQ-EVD-03/AC2+AC3: BUG-08 is FAILED with screen recording, logcat and page source", async () => {
    const record = await attempt("BUG_ANDROID_BACK_EMPTIES_CART");
    expect(record.outcome).toBe("failed");
    expect(record.assertions[2]).toMatchObject({
      stepId: "S3",
      expected: "Cart: 1 item",
      actual: "Cart: 0 items",
      pass: false,
    });
    expect(record.evidence.map((e) => e.name)).toEqual(
      expect.arrayContaining(["S3.png", "failure.png", "screen.mp4", "logcat.log", "page-source.xml"]),
    );
  }, 300_000);
});

const read = (path: string) => readFile(join(root, path), "utf8");
const MOBILE = [
  "mobile:",
  `  appium: { bin: ${join(root, "node_modules/.bin/appium")}, home: ${join(root, ".appium")} }`,
  "  android:",
  "    app: { source: build, repo: shop, command: [node, android/build.mjs], output: android/build/demo-shop.apk }",
  "    app_id: dev.qajitsu.demoshop",
  "    activity: .CartActivity",
  '    intent_args: "--es api_url {{base_url}}"',
  '    emulator: { avd: qajitsu-e2e, system_image: "system-images;android-34;google_apis;arm64-v8a", headless: true, boot_timeout_s: 420 }',
].join("\n");

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

// The real sandbox, as in production (ADR-0004): the built child script, the device driven by the parent.
const childScript = join(root, "packages/adapters/runner-api/dist/child.js");

const runDemo6 = async (set: string[]) => {
  const p = await createBuildProject(
    `${apiService().replace('BUG_CART_TOTAL_ROUNDING: { value: "0", overridable: true }', 'BUG_ANDROID_BACK_EMPTIES_CART: { value: "0", overridable: true }')}\n${MOBILE}`,
    { ports: { mobileExecutor: (device) => createSandboxExecutor({ childScript, browser: device }) } },
  );
  cleanups.push(p.cleanup);
  await copyFile(
    join(root, "examples/demo-shop/tickets/DEMO-6.json"),
    join(p.project, "tickets", "DEMO-6.json"),
  );
  const analysis = JSON.stringify({
    summary: "Android cart.",
    change_type: ["mobile"],
    screens: [{ name: "Cart", source: [{ kind: "ac", id: "AC1" }] }],
    confidence: "high",
  });
  expect((await p.run(["fetch", "DEMO-6", "--ref", "shop=main"])).exitCode).toBe(0);
  expect(
    (
      await p.run(
        ["plan", "DEMO-6"],
        [{ text: analysis }, { text: await read("fixtures/plans/demo-6-draft.json") }],
      )
    ).exitCode,
  ).toBe(0);
  expect((await p.run(["approve", "DEMO-6"])).exitCode).toBe(0);
  const runId = (await readRunIndex(join(p.home, "runs"), "DEMO-6" as TicketKey)).latest ?? "";
  const dir = join(p.home, "runs", "DEMO-6", runId);
  await writeFile(join(dir, "specs", "TC-01.spec.ts"), await read("fixtures/specs/demo-6/TC-01.spec.ts"));
  const result = await p.run(["run", "DEMO-6", "--build", ...set]);
  const record = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as {
    data: { results: Record<string, string> };
  };
  const manifest = JSON.parse(
    await readFile(join(dir, "evidence", "manifest.json"), "utf8").catch(() => "[]"),
  ) as {
    path: string;
  }[];
  return { result, statuses: record.data.results, evidence: manifest.map((m) => m.path) };
};

describe.skipIf(!available)("qj run DEMO-6 --build on an Android emulator (stage 8)", () => {
  it("REQ-EXEC-06 + REQ-ENV-06/AC1+AC2: the clean app built from the worktree PASSES", async () => {
    const { result, statuses, evidence } = await runDemo6([]);
    expect(result.err + result.out).not.toContain("BLOCKED");
    expect(result.err).toBe("");
    expect(statuses).toEqual({ "TC-01": "PASSED" });
    expect(evidence).toEqual(
      expect.arrayContaining(["TC-01/attempt-1/S3.png", "TC-01/attempt-1/logcat.log"]),
    );
  }, 900_000);

  it("REQ-NFR-04/AC1: BUG-08 is FAILED with screen recording and page source", async () => {
    const { result, statuses, evidence } = await runDemo6(["--set", "api.BUG_ANDROID_BACK_EMPTIES_CART=1"]);
    expect(result.exitCode).toBe(1);
    expect(statuses).toEqual({ "TC-01": "FAILED" });
    expect(evidence).toEqual(
      expect.arrayContaining(["TC-01/attempt-1/screen.mp4", "TC-01/attempt-1/page-source.xml"]),
    );
  }, 900_000);
});
