import { copyFile, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPlaywrightTransport, executeAttempt, type BrowserFactory } from "@qajitsu/adapter-runner-api";
import {
  createAppiumDeviceFactory,
  type AppiumClient,
  type AppiumElement,
} from "@qajitsu/adapter-runner-mobile";
import { readRunIndex, type CodeHost, type TicketKey } from "@qajitsu/core";
import { zip } from "@qajitsu/report";
import { afterEach, describe, expect, it } from "vitest";
import { apiService, createBuildProject } from "../../../../tests/support/cli-build.js";
import { openSession } from "../session.js";
import {
  emulatorUrl,
  farmCapabilities,
  prepareMobile,
  resolveAppBinary,
  type PreparedMobile,
} from "./mobile.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const read = (path: string) => readFile(new URL(`../../../../${path}`, import.meta.url), "utf8");

/** A fake Android demo-shop app behind the Appium client API: cart → checkout → back. */
const fakeApp = (backEmptiesCart: boolean): AppiumClient => {
  let items = 0;
  let screen: "cart" | "checkout" = "cart";
  const label = () => `Cart: ${String(items)} ${items === 1 ? "item" : "items"}`;
  const visible = (id: string) =>
    screen === "cart" ? ["add-item", "open-checkout", "cart-count"].includes(id) : id === "checkout-title";
  const element = (sel: string): AppiumElement => {
    const id = sel.slice(1);
    return {
      click: () => {
        if (id === "add-item") items += 1;
        if (id === "open-checkout") screen = "checkout";
        return Promise.resolve();
      },
      setValue: () => Promise.resolve(),
      isDisplayed: () => Promise.resolve(visible(id)),
      isEnabled: () => Promise.resolve(true),
      getAttribute: () => Promise.resolve(null),
      getText: () => Promise.resolve(id === "cart-count" ? label() : id),
      waitForDisplayed: (o) =>
        visible(id) !== (o.reverse === true)
          ? Promise.resolve(true)
          : Promise.reject(new Error(`${id} not displayed`)),
    };
  };
  return {
    $: (sel) => Promise.resolve(element(sel)),
    back: () => {
      if (screen === "checkout" && backEmptiesCart) items = 0;
      screen = "cart";
      return Promise.resolve();
    },
    execute: () => Promise.resolve(),
    keys: () => Promise.resolve(),
    getPageSource: () => Promise.resolve(`<hierarchy screen="${screen}"><x text="${label()}"/></hierarchy>`),
    takeScreenshot: () => Promise.resolve(Buffer.from([137, 80, 78, 71]).toString("base64")),
    startRecordingScreen: () => Promise.resolve(),
    stopRecordingScreen: () => Promise.resolve(Buffer.from("mp4").toString("base64")),
    getLogs: () => Promise.resolve([{ message: "ActivityManager: Start proc dev.qajitsu.demoshop" }]),
    deleteSession: () => Promise.resolve(),
  };
};

const device = (bug: boolean): PreparedMobile => ({
  ok: true,
  factories: [
    createAppiumDeviceFactory({
      platform: "android",
      connect: () => Promise.resolve(fakeApp(bug)),
      capabilities: {},
    }),
  ],
  stop: () => Promise.resolve(),
});
const inProcess =
  (factory: BrowserFactory) => async (input: Parameters<ReturnType<typeof createAppiumDeviceFactory>>[0]) => {
    const { transport, dispose } = await createPlaywrightTransport({ timeoutMs: 5000 });
    try {
      return await executeAttempt(input, transport, Date.now, factory);
    } finally {
      await dispose();
    }
  };

const setup = async (prepared: () => Promise<PreparedMobile>) => {
  const p = await createBuildProject(undefined, {
    ports: { mobileDevice: prepared, mobileExecutor: inProcess },
  });
  cleanups.push(p.cleanup);
  await copyFile(
    new URL("../../../../examples/demo-shop/tickets/DEMO-6.json", import.meta.url),
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
  return { ...p, dir };
};
const statuses = async (dir: string) =>
  (JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as { data: { results: Record<string, string> } })
    .data.results;

describe("mobile cases in qj run (REQ-EXEC-06, REQ-EVD-03, REQ-ENV-06)", () => {
  it("REQ-EXEC-06 + REQ-NFR-04: DEMO-6 PASSES on the clean app with a screenshot per step and device log", async () => {
    const { run, dir } = await setup(() => Promise.resolve(device(false)));
    const result = await run(["run", "DEMO-6", "--build"]);
    expect(result.err).toBe("");
    expect(result.exitCode).toBe(0);
    expect(await statuses(dir)).toEqual({ "TC-01": "PASSED" });
    const manifest = JSON.parse(await readFile(join(dir, "evidence", "manifest.json"), "utf8")) as {
      path: string;
    }[];
    expect(manifest.map((m) => m.path)).toEqual([
      "TC-01/attempt-1/S1.png",
      "TC-01/attempt-1/S2.png",
      "TC-01/attempt-1/S3.png",
      "TC-01/attempt-1/logcat.log",
    ]);
  }, 120_000);

  it("REQ-NFR-04 + REQ-EVD-03/AC2+AC3: BUG-08 (back empties the cart) is FAILED with recording and page source", async () => {
    const { run, dir } = await setup(() => Promise.resolve(device(true)));
    expect((await run(["run", "DEMO-6", "--build"])).exitCode).toBe(1);
    expect(await statuses(dir)).toEqual({ "TC-01": "FAILED" });
    const result = JSON.parse(await readFile(join(dir, "results", "TC-01.json"), "utf8")) as {
      attempts: { assertions: { stepId: string; actual: unknown; pass: boolean }[]; evidence: string[] }[];
    };
    expect(result.attempts[0]?.assertions.find((a) => a.stepId === "S3")).toMatchObject({
      actual: "Cart: 0 items",
      pass: false,
    });
    expect(result.attempts[0]?.evidence).toEqual(
      expect.arrayContaining([
        "TC-01/attempt-1/screen.mp4",
        "TC-01/attempt-1/page-source.xml",
        "TC-01/attempt-1/logcat.log",
      ]),
    );
  }, 120_000);

  it("REQ-EXEC-06/AC3: mobile cases run one after another on the device, whatever environments.workers says", async () => {
    let active = 0;
    let peak = 0;
    const counted: PreparedMobile = {
      ok: true,
      factories: [
        createAppiumDeviceFactory({
          platform: "android",
          connect: async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((r) => setTimeout(r, 50));
            const app = fakeApp(false);
            return { ...app, deleteSession: () => Promise.resolve((active -= 1)) };
          },
          capabilities: {},
        }),
      ],
      stop: () => Promise.resolve(),
    };
    const p = await createBuildProject(apiService(), {
      ports: { mobileDevice: () => Promise.resolve(counted), mobileExecutor: inProcess },
    });
    cleanups.push(p.cleanup);
    const yaml = join(p.project, ".qa", "qa.project.yaml");
    await writeFile(
      yaml,
      (await readFile(yaml, "utf8")).replace(
        "environments: { allowlist:",
        "environments: { workers: 4, allowlist:",
      ),
    );
    await copyFile(
      new URL("../../../../examples/demo-shop/tickets/DEMO-6.json", import.meta.url),
      join(p.project, "tickets", "DEMO-6.json"),
    );
    const draft = JSON.parse(await read("fixtures/plans/demo-6-draft.json")) as { cases: { id: string }[] };
    const twoCases = { ...draft, cases: [draft.cases[0], { ...draft.cases[0], id: "TC-02" }] };
    const analysis = JSON.stringify({
      summary: "Android cart.",
      change_type: ["mobile"],
      screens: [{ name: "Cart", source: [{ kind: "ac", id: "AC1" }] }],
      confidence: "high",
    });
    await p.run(["fetch", "DEMO-6", "--ref", "shop=main"]);
    await p.run(["plan", "DEMO-6"], [{ text: analysis }, { text: JSON.stringify(twoCases) }]);
    await p.run(["approve", "DEMO-6"]);
    const runId = (await readRunIndex(join(p.home, "runs"), "DEMO-6" as TicketKey)).latest ?? "";
    const dir = join(p.home, "runs", "DEMO-6", runId);
    const spec = await read("fixtures/specs/demo-6/TC-01.spec.ts");
    await writeFile(join(dir, "specs", "TC-01.spec.ts"), spec);
    await writeFile(join(dir, "specs", "TC-02.spec.ts"), spec.replaceAll("TC-01", "TC-02"));
    expect((await p.run(["run", "DEMO-6", "--build"])).exitCode).toBe(0);
    expect(await statuses(dir)).toEqual({ "TC-01": "PASSED", "TC-02": "PASSED" });
    expect(peak).toBe(1);
  }, 120_000);

  it("REQ-EXEC-10/AC2: with several devices the cases are split among them; each device runs one case at a time", async () => {
    let total = 0;
    let peakTotal = 0;
    const perDevice: number[] = [0, 0];
    const peakPerDevice: number[] = [0, 0];
    const casesPerDevice: number[] = [0, 0];
    const counting = (index: 0 | 1) =>
      createAppiumDeviceFactory({
        platform: "android",
        connect: async () => {
          total += 1;
          const onDevice = (perDevice[index] ?? 0) + 1;
          perDevice[index] = onDevice;
          casesPerDevice[index] = (casesPerDevice[index] ?? 0) + 1;
          peakTotal = Math.max(peakTotal, total);
          peakPerDevice[index] = Math.max(peakPerDevice[index] ?? 0, onDevice);
          await new Promise((r) => setTimeout(r, 100));
          const app = fakeApp(false);
          return {
            ...app,
            deleteSession: () => {
              total -= 1;
              perDevice[index] = (perDevice[index] ?? 0) - 1;
              return Promise.resolve();
            },
          };
        },
        capabilities: {},
      });
    const two: PreparedMobile = {
      ok: true,
      factories: [counting(0), counting(1)],
      stop: () => Promise.resolve(),
    };
    const p = await createBuildProject(apiService(), {
      ports: { mobileDevice: () => Promise.resolve(two), mobileExecutor: inProcess },
    });
    cleanups.push(p.cleanup);
    await copyFile(
      new URL("../../../../examples/demo-shop/tickets/DEMO-6.json", import.meta.url),
      join(p.project, "tickets", "DEMO-6.json"),
    );
    const draft = JSON.parse(await read("fixtures/plans/demo-6-draft.json")) as { cases: { id: string }[] };
    const ids = ["TC-01", "TC-02", "TC-03", "TC-04"];
    const fourCases = { ...draft, cases: ids.map((id) => ({ ...draft.cases[0], id })) };
    const analysis = JSON.stringify({
      summary: "Android cart.",
      change_type: ["mobile"],
      screens: [{ name: "Cart", source: [{ kind: "ac", id: "AC1" }] }],
      confidence: "high",
    });
    await p.run(["fetch", "DEMO-6", "--ref", "shop=main"]);
    await p.run(["plan", "DEMO-6"], [{ text: analysis }, { text: JSON.stringify(fourCases) }]);
    await p.run(["approve", "DEMO-6"]);
    const runId = (await readRunIndex(join(p.home, "runs"), "DEMO-6" as TicketKey)).latest ?? "";
    const dir = join(p.home, "runs", "DEMO-6", runId);
    const spec = await read("fixtures/specs/demo-6/TC-01.spec.ts");
    for (const id of ids) await writeFile(join(dir, "specs", `${id}.spec.ts`), spec.replaceAll("TC-01", id));
    const result = await p.run(["run", "DEMO-6", "--build"]);
    expect(result.err).toBe("");
    expect(result.exitCode).toBe(0);
    expect(await statuses(dir)).toEqual(Object.fromEntries(ids.map((id) => [id, "PASSED"])));
    expect(peakPerDevice).toEqual([1, 1]);
    expect(peakTotal).toBe(2);
    expect(casesPerDevice).toEqual([2, 2]);
  }, 120_000);

  it("REQ-ENV-06/AC3: an unavailable platform makes mobile cases BLOCKED with the reason", async () => {
    const { run, dir } = await setup(() =>
      Promise.resolve({
        ok: false,
        reason: "iOS needs macOS with Xcode or a device farm (mobile.ios.farm: browserstack or saucelabs)",
      }),
    );
    const result = await run(["run", "DEMO-6", "--build"]);
    expect(result.exitCode).toBe(2);
    expect(result.err).toContain("Mobile cases are BLOCKED: iOS needs macOS with Xcode or a device farm");
    expect(await statuses(dir)).toEqual({ "TC-01": "BLOCKED" });
  }, 120_000);
});

describe("app binaries and devices (REQ-ENV-06)", () => {
  const session = async (mobileYaml: string) => {
    const p = await createBuildProject(undefined);
    cleanups.push(p.cleanup);
    const yaml = join(p.project, ".qa", "qa.project.yaml");
    await writeFile(yaml, `${await readFile(yaml, "utf8")}\n${mobileYaml}`);
    expect((await p.run(["fetch", "DEMO-1"])).exitCode).toBe(0);
    return {
      p,
      s: await openSession("DEMO-1", undefined, p.project, {
        env: {},
        home: p.home,
        now: () => new Date(),
        random: Math.random,
        fetch: globalThis.fetch,
        gitExec: async () => Promise.resolve({ stdout: "", stderr: "" }),
      }),
    };
  };

  it("REQ-ENV-06/AC1: the app comes from a CI artifact of exactly the analysed SHA, a worktree file or a build", async () => {
    const { s } = await session("");
    const sha = s.ws.record.repos["shop"]?.sha ?? "";
    let asked: string[] = [];
    const host = {
      downloadArtifact: (repo: string, at: string, name: string) => {
        asked = [repo, at, name];
        return Promise.resolve(zip([{ name: "outputs/apk/app-debug.apk", data: new Uint8Array([1, 2, 3]) }]));
      },
    } as unknown as CodeHost;
    const fromCi = await resolveAppBinary(
      s,
      { source: "ci", repo: "shop", artifact: "app-debug", file: "*.apk" },
      { local: host },
      s.project.config,
    );
    expect(asked).toEqual(["demo-org/demo-shop", sha, "app-debug"]);
    expect(fromCi).toBe(s.ws.path("env", "app", "app-debug.apk"));
    expect([...(await readFile(fromCi))]).toEqual([1, 2, 3]);
    await expect(
      resolveAppBinary(
        s,
        { source: "ci", repo: "shop", artifact: "app-debug", file: "*.ipa" },
        { local: host },
        s.project.config,
      ),
    ).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
    await expect(
      resolveAppBinary(s, { source: "ci", repo: "shop", artifact: "x", file: "*.apk" }, {}, s.project.config),
    ).rejects.toThrow(/cannot download CI artifacts/);
    // From the worktree, and built by an argument-array command in the worktree.
    expect(
      await resolveAppBinary(s, { source: "path", repo: "shop", path: "cart.ts" }, {}, s.project.config),
    ).toBe(await realpath(s.ws.path("repos", "shop", "cart.ts")));
    const built = await resolveAppBinary(
      s,
      {
        source: "build",
        repo: "shop",
        command: ["node", "-e", "require('fs').writeFileSync('app.apk','x')"],
        output: "app.apk",
      },
      {},
      s.project.config,
    );
    expect(await readFile(built, "utf8")).toBe("x");
    await expect(
      resolveAppBinary(
        s,
        { source: "build", repo: "shop", command: ["node", "-e", "process.exit(3)"], output: "a.apk" },
        {},
        s.project.config,
      ),
    ).rejects.toMatchObject({ code: "APP_BUILD_FAILED" });
    await expect(
      resolveAppBinary(s, { source: "path", repo: "other", path: "x" }, {}, s.project.config),
    ).rejects.toThrow(/not fetched/);
  }, 120_000);

  it("REQ-ENV-06/AC3: without a mobile section, iOS without a farm, or a missing app the reason is clear", async () => {
    const none = await session("");
    expect(await prepareMobile(none.s, "http://127.0.0.1:1", {}, undefined)).toEqual({
      ok: false,
      reason: "mobile cases need the mobile section in .qa/qa.project.yaml",
    });
    const ios = await session(
      "mobile: { ios: { app: { source: path, repo: shop, path: app.ipa }, bundle_id: dev.qajitsu.demoshop } }",
    );
    const r = await prepareMobile(ios.s, "http://127.0.0.1:1", {}, undefined);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toMatch(/iOS .*(Xcode|device farm)/);
    const android = await session(
      "mobile: { android: { app: { source: path, repo: shop, path: missing.apk }, app_id: dev.qajitsu.demoshop } }",
    );
    expect(await prepareMobile(android.s, "http://127.0.0.1:1", {}, undefined)).toEqual({
      ok: false,
      reason: "App binary missing.apk not found in the worktree.",
    });
  }, 120_000);

  it("stage-8 review: builds need --build and a throwaway HOME; symlinks out of the worktree and unsafe launch args are refused", async () => {
    const build = await session(
      "mobile: { android: { app: { source: build, repo: shop, command: [node, x.mjs], output: a.apk }, app_id: dev.qajitsu.demoshop } }",
    );
    expect(await prepareMobile(build.s, "http://127.0.0.1:1", {}, undefined)).toEqual({
      ok: false,
      reason: "the app is built from the analysed branch only with --build (it runs the branch's code)",
    });
    const home = await resolveAppBinary(
      build.s,
      {
        source: "build",
        repo: "shop",
        command: ["node", "-e", "require('fs').writeFileSync('h.apk', process.env.HOME)"],
        output: "h.apk",
      },
      {},
      build.s.project.config,
    );
    expect(await readFile(home, "utf8")).toBe(build.s.ws.path("env", "build-home"));
    const { symlink } = await import("node:fs/promises");
    await symlink(
      join(build.p.home, "project", ".qa", "qa.project.yaml"),
      build.s.ws.path("repos", "shop", "evil.apk"),
    );
    await expect(
      resolveAppBinary(
        build.s,
        { source: "path", repo: "shop", path: "evil.apk" },
        {},
        build.s.project.config,
      ),
    ).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
    const { parseProjectConfig } = await import("@qajitsu/core");
    expect(() =>
      parseProjectConfig({
        project: "x",
        jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
        mobile: {
          android: {
            app: { source: "path", repo: "a", path: "a.apk" },
            app_id: "a.b",
            intent_args: "--es x $(id); rm -rf /",
          },
        },
      }),
    ).toThrow();
  }, 120_000);

  it("emulator networking and device farm capabilities", () => {
    expect(emulatorUrl("http://127.0.0.1:51234")).toBe("http://10.0.2.2:51234");
    expect(emulatorUrl("http://localhost/x")).toBe("http://10.0.2.2/x");
    expect(emulatorUrl("https://staging.example.com")).toBe("https://staging.example.com");
    const farm = {
      username: "secret://env/U",
      access_key: "secret://env/K",
      device: "iPhone 15",
      os_version: "17",
    };
    expect(
      farmCapabilities(
        { ...farm, provider: "browserstack", app: "bs://abc", vendor_recording: false },
        "dev.x",
      ),
    ).toMatchObject({
      platformName: "iOS",
      "appium:automationName": "XCUITest",
      "appium:app": "bs://abc",
      "appium:deviceName": "iPhone 15",
      "bstack:options": { video: false, deviceLogs: false },
    });
    expect(
      farmCapabilities(
        { ...farm, provider: "saucelabs", app: "storage:filename=a.ipa", vendor_recording: true },
        "dev.x",
      ),
    ).toHaveProperty("sauce:options");
  });
});
