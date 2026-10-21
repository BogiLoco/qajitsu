import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPlaywrightTransport, executeAttempt, type BrowserFactory } from "@qajitsu/adapter-runner-api";
import { createAppiumDeviceFactory, type AppiumClient } from "@qajitsu/adapter-runner-mobile";
import { parseEventLines, readRunIndex, type TicketKey } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { analysis, apiService, createBuildProject, draft } from "../../../../tests/support/cli-build.js";
import { inProcessExecutor } from "../../../../tests/support/cli-pipeline.js";
import { runLimited } from "./lanes.js";
import type { PreparedMobile } from "./mobile.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const read = (path: string) => readFile(new URL(`../../../../${path}`, import.meta.url), "utf8");
const statuses = async (dir: string) =>
  (JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as { data: { results: Record<string, string> } })
    .data.results;
const journal = async (dir: string) =>
  parseEventLines(await readFile(join(dir, "journal", "events.jsonl"), "utf8")).events;

/** A fake demo-shop app; `bug` makes back empty the cart (BUG-08). */
const fakeApp = (bug: boolean, onConnect?: () => void): AppiumClient => {
  onConnect?.();
  let items = 0;
  let screen: "cart" | "checkout" = "cart";
  const label = () => `Cart: ${String(items)} ${items === 1 ? "item" : "items"}`;
  const visible = (id: string) =>
    screen === "cart" ? ["add-item", "open-checkout", "cart-count"].includes(id) : id === "checkout-title";
  return {
    $: (sel) => {
      // `testid:x` on Android is an XPath over content-desc and resource id (REQ-EXEC-21/AC2).
      const id = /@content-desc="([^"]*)"/.exec(sel)?.[1] ?? sel.slice(1);
      return Promise.resolve({
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
      });
    },
    back: () => {
      if (screen === "checkout" && bug) items = 0;
      screen = "cart";
      return Promise.resolve();
    },
    execute: () => Promise.resolve(),
    keys: () => Promise.resolve(),
    getPageSource: () => Promise.resolve(`<hierarchy><x text="${label()}"/></hierarchy>`),
    takeScreenshot: () => Promise.resolve(Buffer.from([137, 80, 78, 71]).toString("base64")),
    startRecordingScreen: () => Promise.resolve(),
    stopRecordingScreen: () => Promise.resolve(Buffer.from("mp4").toString("base64")),
    getLogs: () => Promise.resolve([]),
    deleteSession: () => Promise.resolve(),
  };
};
const factory = (bug: boolean, onConnect?: () => void): BrowserFactory =>
  createAppiumDeviceFactory({
    platform: "android",
    connect: () => Promise.resolve(fakeApp(bug, onConnect)),
    capabilities: {},
  });
const mobileExecutor =
  (f: BrowserFactory) => async (input: Parameters<ReturnType<typeof createAppiumDeviceFactory>>[0]) => {
    const { transport, dispose } = await createPlaywrightTransport({ timeoutMs: 5000 });
    try {
      return await executeAttempt(input, transport, Date.now, f);
    } finally {
      await dispose();
    }
  };

const pool = (size: number) =>
  `accounts:\n  user:standard:\n    pool:\n${Array.from(
    { length: size },
    () => "      - { username: standard, password: secret://env/DEMO_USER_PASSWORD }\n",
  ).join("")}`;

/** A --build project of DEMO-1 with the given profile accounts and extra config. */
async function project(
  options: {
    readonly accounts?: string;
    readonly config?: string;
    readonly executor?: Parameters<typeof createBuildProject>[1] extends infer O
      ? O extends { ports?: infer P }
        ? P extends { executor?: infer E }
          ? E
          : never
        : never
      : never;
    readonly mobileDevice?: () => Promise<PreparedMobile>;
    readonly platform?: string;
  } = {},
) {
  const p = await createBuildProject(`${apiService()}\n${options.config ?? ""}`, {
    ports: {
      ...(options.executor ? { executor: options.executor } : {}),
      ...(options.mobileDevice ? { mobileDevice: options.mobileDevice, mobileExecutor } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
    },
  });
  cleanups.push(p.cleanup);
  if (options.accounts !== undefined) {
    const profile = join(p.project, ".qa", "envs", "local.yaml");
    const text = await readFile(profile, "utf8");
    await writeFile(
      profile,
      text.replace(
        "accounts:\n  user:standard: { username: standard, password: secret://env/DEMO_USER_PASSWORD }\n",
        options.accounts,
      ),
    );
  }
  return p;
}

/** Wraps the API executor to measure how many cases run at the same time. */
function concurrency() {
  let active = 0;
  let peak = 0;
  return {
    peak: () => peak,
    executor: async (input: Parameters<typeof inProcessExecutor>[0]) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise((r) => setTimeout(r, 150));
        return await inProcessExecutor(input);
      } finally {
        active -= 1;
      }
    },
  };
}

describe("account pools in qj run (REQ-ENV-09)", () => {
  it("REQ-ENV-09/AC2+AC5: cases running at the same time hold different accounts; the journal names the pool member", async () => {
    const c = concurrency();
    const p = await project({
      accounts: pool(2),
      config: "execution: { workers: { api: 2 } }",
      executor: c.executor,
    });
    const dir = await p.prepare();
    expect((await p.run(["run", "DEMO-1", "--build"])).exitCode).toBe(0);
    expect(c.peak()).toBe(2);
    const leased = (await journal(dir))
      .filter((e) => e.event === "case.accounts")
      .map(
        (e) =>
          e.details as { caseId: string; attempt: number; lane: string; accounts: Record<string, string> },
      );
    const first = leased.filter((l) => l.attempt === 1);
    expect(first.map((l) => l.lane)).toEqual(["api", "api"]);
    expect(new Set(first.map((l) => l.accounts["user:standard"]))).toEqual(
      new Set(["user:standard#1", "user:standard#2"]),
    );
    // Never the user name.
    expect(JSON.stringify(leased)).not.toContain('"standard"');
  }, 120_000);

  it("REQ-ENV-09/AC2: with one account, cases that need it run one after another whatever the workers", async () => {
    const c = concurrency();
    const p = await project({
      accounts: pool(1),
      config: "execution: { workers: { api: 2 } }",
      executor: c.executor,
    });
    const dir = await p.prepare();
    await p.run(["run", "DEMO-1", "--build"]);
    expect(c.peak()).toBe(1);
    expect(Object.keys(await statuses(dir)).sort()).toEqual(["TC-01", "TC-02"]);
  }, 120_000);

  it("REQ-ENV-09/AC4: no free account in time makes the case BLOCKED with the reason", async () => {
    const c = concurrency();
    const p = await project({
      accounts: pool(1),
      config: "execution: { workers: { api: 2 }, account_wait_s: 0 }",
      executor: c.executor,
    });
    const dir = await p.prepare();
    await p.run(["run", "DEMO-1", "--build"]);
    const results = await statuses(dir);
    expect(Object.values(results)).toContain("BLOCKED");
    const blocked = Object.entries(results).find(([, s]) => s === "BLOCKED")?.[0] ?? "";
    const file = JSON.parse(await readFile(join(dir, "results", `${blocked}.json`), "utf8")) as {
      attempts: { error?: string }[];
    };
    expect(file.attempts[0]?.error).toContain("no free account of user:standard within 0 s");
  }, 120_000);
});

describe("qj env check with pools (REQ-ENV-09/AC5)", () => {
  it("REQ-ENV-09/AC5: warns when a pool is smaller than the cases that can need it; checks every member's secrets", async () => {
    const p = await project({
      accounts:
        "accounts:\n  user:standard:\n    pool:\n      - { username: standard, password: secret://env/DEMO_USER_PASSWORD }\n      - { username: other, password: secret://env/MISSING_PASSWORD }\n",
      config: "execution: { workers: { api: 4 } }",
    });
    const result = await p.run(["env", "check"]);
    expect(result.out).toContain(
      "! accounts: user:standard has 2 accounts, up to 5 cases can need it at once (api 4, web 1); the others wait for a free one",
    );
    expect(result.out).toContain(
      "✘ accounts.user:standard.pool[1].password: secret secret://env/MISSING_PASSWORD cannot be resolved",
    );
    expect(result.exitCode).toBe(3);
  }, 120_000);
});

describe("lanes and sequential runs (REQ-EXEC-19)", () => {
  /** DEMO-1 with one API case and one mobile case (DEMO-6's) and their specs. */
  async function mixedRun(
    executor: (input: Parameters<typeof inProcessExecutor>[0]) => ReturnType<typeof inProcessExecutor>,
    device: () => Promise<PreparedMobile>,
    config = "",
  ) {
    const p = await project({ executor, mobileDevice: device, config, platform: "darwin" });
    const api = JSON.parse(draft) as { cases: { id: string }[] };
    const mobile = JSON.parse(await read("fixtures/plans/demo-6-draft.json")) as {
      cases: Record<string, unknown>[];
    };
    const plan = { ...api, cases: [api.cases[0], { ...mobile.cases[0], id: "TC-02" }] };
    expect((await p.run(["fetch", "DEMO-1"])).exitCode).toBe(0);
    expect(
      (await p.run(["plan", "DEMO-1"], [{ text: analysis }, { text: JSON.stringify(plan) }])).exitCode,
    ).toBe(0);
    // The mobile case replaces the one that covered AC3 (REQ-PLAN-14/AC4).
    expect((await p.run(["approve", "DEMO-1", "--confirm-uncovered"])).exitCode).toBe(0);
    const runId = (await readRunIndex(join(p.home, "runs"), "DEMO-1" as TicketKey)).latest ?? "";
    const dir = join(p.home, "runs", "DEMO-1", runId);
    await copyFile(
      new URL("../../../../fixtures/specs/demo-1/TC-01.spec.ts", import.meta.url),
      join(dir, "specs", "TC-01.spec.ts"),
    );
    await writeFile(
      join(dir, "specs", "TC-02.spec.ts"),
      (await read("fixtures/specs/demo-6/TC-01.spec.ts")).replaceAll("TC-01", "TC-02"),
    );
    return { p, dir };
  }

  /** The API case waits up to 2 s for the mobile case to start; it records whether it did. */
  function watcher() {
    let mobileStarted = false;
    let sawMobile: boolean | undefined;
    return {
      sawMobile: () => sawMobile,
      device: (): Promise<PreparedMobile> =>
        Promise.resolve({
          ok: true,
          factories: [factory(false, () => (mobileStarted = true))],
          stop: () => Promise.resolve(),
        }),
      executor: async (input: Parameters<typeof inProcessExecutor>[0]) => {
        for (let i = 0; i < 40 && !mobileStarted; i++) await new Promise((r) => setTimeout(r, 50));
        sawMobile ??= mobileStarted;
        return inProcessExecutor(input);
      },
    };
  }

  it("REQ-EXEC-19/AC1: API and mobile cases run at the same time", async () => {
    const w = watcher();
    const { p, dir } = await mixedRun(w.executor, w.device);
    expect((await p.run(["run", "DEMO-1", "--build"])).exitCode).toBe(0);
    expect(w.sawMobile()).toBe(true);
    expect(await statuses(dir)).toEqual({ "TC-01": "PASSED", "TC-02": "PASSED" });
    const lanes = (await journal(dir)).filter((e) => e.event === "case.attempt.start").map((e) => e.details);
    expect(lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ caseId: "TC-01", lane: "api" }),
        expect.objectContaining({ caseId: "TC-02", lane: "mobile" }),
      ]),
    );
  }, 120_000);

  it.each([
    ["the --sequential flag", ["--sequential"], ""],
    ["execution.sequential", [], "execution: { sequential: true }"],
    // REQ-EXEC-19/AC5: a person watching follows one case at a time.
    ["--headed", ["--headed"], ""],
  ])(
    "REQ-EXEC-19/AC2: %s runs one case at a time in plan order",
    async (_, flags, config) => {
      const w = watcher();
      const { p, dir } = await mixedRun(w.executor, w.device, config);
      expect((await p.run(["run", "DEMO-1", "--build", ...flags])).exitCode).toBe(0);
      expect(w.sawMobile()).toBe(false);
      const starts = (await journal(dir))
        .filter((e) => e.event === "case.attempt.start")
        .map((e) => (e.details as { caseId: string }).caseId);
      expect(starts).toEqual(["TC-01", "TC-02"]);
    },
    120_000,
  );
});

describe("several different mobile devices (REQ-EXEC-20)", () => {
  const devices = (distribute: "split" | "matrix") =>
    [
      "mobile:",
      `  distribute: ${distribute}`,
      "  android:",
      "    app: { source: path, repo: shop, path: app.apk }",
      "    app_id: dev.qajitsu.demoshop",
      "    emulators:",
      '      - { name: pixel, avd: qj-pixel, system_image: "system-images;android-34;google_apis;arm64-v8a", device: pixel_8 }',
      '      - { name: tablet, avd: qj-tablet, system_image: "system-images;android-33;google_apis;arm64-v8a" }',
    ].join("\n");

  async function deviceRun(distribute: "split" | "matrix", device: () => Promise<PreparedMobile>, cases = 1) {
    const p = await project({ mobileDevice: device, config: devices(distribute) });
    await copyFile(
      new URL("../../../../examples/demo-shop/tickets/DEMO-6.json", import.meta.url),
      join(p.project, "tickets", "DEMO-6.json"),
    );
    const plan = JSON.parse(await read("fixtures/plans/demo-6-draft.json")) as {
      cases: Record<string, unknown>[];
    };
    const ids = Array.from({ length: cases }, (_, i) => `TC-0${String(i + 1)}`);
    const many = { ...plan, cases: ids.map((id) => ({ ...plan.cases[0], id })) };
    const screens = JSON.stringify({
      summary: "Android cart.",
      change_type: ["mobile"],
      screens: [{ name: "Cart", source: [{ kind: "ac", id: "AC1" }] }],
      confidence: "high",
    });
    await p.run(["fetch", "DEMO-6", "--ref", "shop=main"]);
    await p.run(["plan", "DEMO-6"], [{ text: screens }, { text: JSON.stringify(many) }]);
    await p.run(["approve", "DEMO-6"]);
    const runId = (await readRunIndex(join(p.home, "runs"), "DEMO-6" as TicketKey)).latest ?? "";
    const dir = join(p.home, "runs", "DEMO-6", runId);
    const spec = await read("fixtures/specs/demo-6/TC-01.spec.ts");
    for (const id of ids) await writeFile(join(dir, "specs", `${id}.spec.ts`), spec.replaceAll("TC-01", id));
    return { p, dir };
  }

  it("REQ-EXEC-20/AC2+AC3: matrix runs every case on every device; one device failing makes it FAILED, shown per device", async () => {
    const { p, dir } = await deviceRun("matrix", () =>
      Promise.resolve({
        ok: true,
        factories: [factory(false), factory(true)],
        names: ["pixel", "tablet"],
        primary: "pixel",
        stop: () => Promise.resolve(),
      }),
    );
    expect((await p.run(["run", "DEMO-6", "--build"])).exitCode).toBe(1);
    expect(await statuses(dir)).toEqual({ "TC-01": "FAILED" });
    expect(JSON.parse(await readFile(join(dir, "results", "TC-01.json"), "utf8"))).toMatchObject({
      attempts: [expect.objectContaining({ outcome: "passed" })],
    });
    const tablet = JSON.parse(
      await readFile(join(dir, "results", "devices", "tablet", "TC-01.json"), "utf8"),
    ) as {
      attempts: { outcome: string; evidence: string[] }[];
    };
    expect(tablet.attempts[0]?.outcome).toBe("failed");
    expect(tablet.attempts[0]?.evidence[0]).toMatch(/^devices\/tablet\/TC-01\//);
    const matrix = await readFile(join(dir, "report", "matrix.md"), "utf8");
    expect(matrix).toContain("| Devices |");
    expect(matrix).toContain("pixel PASSED, tablet FAILED");
    expect(await readFile(join(dir, "report", "report.html"), "utf8")).toContain(
      "Devices: pixel PASSED, tablet FAILED",
    );
  }, 120_000);

  it("REQ-EXEC-20/AC4: in matrix mode a device that did not start is BLOCKED with the reason, the others go on", async () => {
    const { p, dir } = await deviceRun("matrix", () =>
      Promise.resolve({
        ok: true,
        factories: [factory(false)],
        names: ["pixel"],
        failed: [{ name: "tablet", reason: "boot timed out" }],
        primary: "pixel",
        stop: () => Promise.resolve(),
      }),
    );
    const result = await p.run(["run", "DEMO-6", "--build"]);
    expect(result.err).toContain("Mobile device tablet did not start: boot timed out");
    expect(await statuses(dir)).toEqual({ "TC-01": "BLOCKED" });
    const tablet = JSON.parse(
      await readFile(join(dir, "results", "devices", "tablet", "TC-01.json"), "utf8"),
    ) as {
      attempts: { error: string }[];
    };
    expect(tablet.attempts[0]?.error).toBe("mobile device tablet not available: boot timed out");
  }, 120_000);

  it("REQ-EXEC-20/AC2+AC4: split divides the cases among the devices that started", async () => {
    const used: string[] = [];
    const { p, dir } = await deviceRun(
      "split",
      () =>
        Promise.resolve({
          ok: true,
          factories: [factory(false, () => used.push("pixel"))],
          names: ["pixel"],
          failed: [{ name: "tablet", reason: "no system image" }],
          stop: () => Promise.resolve(),
        }),
      3,
    );
    expect((await p.run(["run", "DEMO-6", "--build"])).exitCode).toBe(0);
    expect(await statuses(dir)).toEqual({ "TC-01": "PASSED", "TC-02": "PASSED", "TC-03": "PASSED" });
    expect(used).toEqual(["pixel", "pixel", "pixel"]);
  }, 120_000);
});

describe("runLimited", () => {
  it("runs at most the limit at once and every task to its end before throwing", async () => {
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    const task =
      (n: number, fail = false) =>
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        done.push(n);
        if (fail) throw new Error(`task ${String(n)}`);
      };
    await expect(runLimited([task(1, true), task(2), task(3), task(4)], 2)).rejects.toThrow("task 1");
    expect(peak).toBe(2);
    expect(done.sort()).toEqual([1, 2, 3, 4]);
    await runLimited([], 3);
  });
});
