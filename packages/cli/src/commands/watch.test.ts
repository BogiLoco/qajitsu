import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PlanSchema, type RunEvent } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildProject } from "../../../../tests/support/cli-build.js";
import { createProgressPrinter, liveScreenshots, teeEvents } from "./progress.js";
import { computeWatchProgress, serveWatch, WATCH_PAGE } from "./watch.js";
import { openSession } from "../session.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-1",
  version: 1,
  summary: "s",
  cases: ["TC-01", "TC-02"].map((id) => ({
    id,
    title: `Case ${id}`,
    type: "web",
    priority: "high",
    source: [{ kind: "ac", id: "AC1" }],
    steps: [
      { id: "S1", action: "Open the cart", expect: { description: "Cart shown" } },
      { id: "S2", action: "Apply the code", expect: { description: "Total reduced" } },
    ],
    evidence: ["screenshot"],
  })),
  open_questions: [],
  out_of_scope: [],
});

const ev = (event: string, details: Record<string, unknown>, ts: string, stage = "run"): RunEvent => ({
  ts,
  run: "r",
  ticket: "DEMO-1",
  stage,
  actor: { kind: "runner", name: "api" },
  event,
  details,
});

describe("live progress model (REQ-OBS-09)", () => {
  const base = {
    ticket: "DEMO-1",
    runId: "r",
    plan,
    screenshots: new Set<string>(),
    now: Date.parse("2026-10-07T10:05:00Z"),
  };
  const started = [
    ev("stage.start", {}, "2026-10-07T10:00:00Z"),
    ev("case.attempt.start", { caseId: "TC-01", attempt: 1 }, "2026-10-07T10:00:01Z"),
    ev("step.start", { caseId: "TC-01", attempt: 1, step: "S1" }, "2026-10-07T10:00:02Z"),
    ev("step.start", { caseId: "TC-01", attempt: 1, step: "S2" }, "2026-10-07T10:00:03Z"),
  ];

  it("REQ-OBS-09/AC2+AC3: shows the running case and step; finished attempts are preliminary, not statuses", () => {
    const p = computeWatchProgress({
      ...base,
      events: [
        ...started,
        ev("case.attempt.end", { caseId: "TC-01", attempt: 1, outcome: "passed" }, "2026-10-07T10:00:04Z"),
        ev("case.attempt.start", { caseId: "TC-02", attempt: 1 }, "2026-10-07T10:00:05Z"),
        ev("step.start", { caseId: "TC-02", attempt: 1, step: "S1" }, "2026-10-07T10:00:06Z"),
      ],
      running: true,
      screenshots: new Set(["TC-02"]),
    });
    expect(p.state).toBe("running");
    expect(p.elapsedMs).toBe(300_000);
    expect(p.quietMs).toBe(294_000);
    expect(p.cases).toEqual([
      {
        id: "TC-01",
        title: "Case TC-01",
        type: "web",
        state: "done",
        attempt: 1,
        preliminary: "passed",
        screenshot: false,
      },
      {
        id: "TC-02",
        title: "Case TC-02",
        type: "web",
        state: "running",
        attempt: 1,
        step: { id: "S1", action: "Open the cart" },
        screenshot: true,
      },
    ]);
  });

  it("REQ-OBS-09/AC4: a run that is not running and never finished is stopped, with its last event", () => {
    const p = computeWatchProgress({ ...base, events: started, running: false });
    expect(p.state).toBe("stopped");
    expect(p.lastEvent).toEqual({ at: "2026-10-07T10:00:03Z", event: "step.start" });
    expect(p.cases.find((c) => c.id === "TC-01")).toMatchObject({ state: "running", step: { id: "S2" } });
    expect(p.cases.some((c) => c.status !== undefined)).toBe(false);
    expect(computeWatchProgress({ ...base, events: [], running: false }).state).toBe("not started");
  });

  it("REQ-OBS-09/AC3: after the run the computed statuses replace the preliminary outcomes", () => {
    const p = computeWatchProgress({
      ...base,
      events: [
        ...started,
        ev("case.attempt.end", { caseId: "TC-01", attempt: 1, outcome: "passed" }, "2026-10-07T10:00:04Z"),
        ev("case.blocked", { caseId: "TC-02", reason: "spec" }, "2026-10-07T10:00:04Z"),
        ev("case.not_run", { caseId: "TC-03" }, "2026-10-07T10:00:04Z"),
        ev("stage.end", {}, "2026-10-07T10:00:09Z"),
      ],
      running: false,
      final: new Map([
        ["TC-01", "NEEDS_REVIEW"],
        ["TC-02", "BLOCKED"],
      ]),
    });
    expect(p.state).toBe("finished");
    expect(p.elapsedMs).toBe(9000);
    expect(p.quietMs).toBe(0);
    expect(p.cases.map((c) => [c.id, c.state, c.status, c.preliminary])).toEqual([
      ["TC-01", "done", "NEEDS_REVIEW", "passed"],
      ["TC-02", "done", "BLOCKED", "blocked"],
    ]);
  });

  it("the page inserts every text as text and loads nothing from outside", () => {
    expect(WATCH_PAGE).not.toContain("innerHTML");
    expect(WATCH_PAGE).not.toMatch(/src="http|href="http/);
  });
});

describe("progress in the terminal (REQ-OBS-09/AC1)", () => {
  it("REQ-OBS-09/AC1: prints case starts with a counter, steps and attempt outcomes as plain lines", () => {
    let out = "";
    let t = 0;
    const print = createProgressPrinter(
      { write: (s) => (out += s), writeError: () => undefined, cwd: "/" },
      plan,
      2,
      () => t,
      0,
    );
    const written: string[] = [];
    const events = teeEvents({ emit: (_s, _a, e) => void written.push(e) }, print);
    const actor = { kind: "runner", name: "api" } as const;
    t = 1000;
    events.emit("run", actor, "case.attempt.start", { caseId: "TC-02", attempt: 1 });
    events.emit("run", actor, "step.start", { caseId: "TC-02", attempt: 1, step: "S1" });
    t = 64_500;
    events.emit("run", actor, "case.attempt.end", { caseId: "TC-02", attempt: 1, outcome: "failed" });
    events.emit("run", actor, "case.attempt.start", { caseId: "TC-02", attempt: 2 });
    events.emit("run", actor, "stage.start", {});
    expect(out).toBe(
      [
        "[00:01] ▶ TC-02 (1/2)",
        "[00:01]   TC-02 S1: Open the cart",
        "[01:04] ■ TC-02 attempt 1: failed (63.5 s)",
        "[01:04] ▶ TC-02 (1/2) attempt 2",
        "",
      ].join("\n"),
    );
    expect(written).toHaveLength(5);
  });

  it("REQ-OBS-09/AC1: a failing printer never stops the run's journal", () => {
    const written: string[] = [];
    const events = teeEvents({ emit: (_s, _a, e) => void written.push(e) }, () => {
      throw new Error("terminal closed");
    });
    expect(() => {
      events.emit("run", { kind: "runner", name: "api" }, "step.start", { caseId: "TC-01" });
    }).not.toThrow();
    expect(written).toEqual(["step.start"]);
  });
});

describe("qj watch (REQ-OBS-09/AC2+AC4)", () => {
  it("REQ-OBS-09/AC2+AC4: serves the page, the progress and live screenshots on 127.0.0.1, nothing else", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    const run = await p.run(["run", "DEMO-1", "--build"]);
    expect(run.out).toMatch(/\[\d\d:\d\d\] ▶ TC-01 \(1\/2\)/);
    expect(run.out).toMatch(/\[\d\d:\d\d\] {3}TC-01 S1: /);
    expect(run.out).toMatch(/\[\d\d:\d\d\] ■ TC-01 attempt 1: passed/);
    const live = liveScreenshots(join(dir, "live"));
    live("TC-01", "S1", new Uint8Array([137, 80, 78, 71]));
    live("../run", "S1", new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 100));
    await mkdir(join(dir, "live"), { recursive: true });
    await writeFile(join(dir, "live", "secret.txt"), "x");

    const ports = {
      env: {},
      home: p.home,
      now: () => new Date(),
      random: () => 0,
      fetch: globalThis.fetch,
      gitExec: () => Promise.reject(new Error("no git")),
    } as unknown as Parameters<typeof openSession>[3];
    const session = await openSession("DEMO-1", undefined, p.project, ports);
    const watch = await serveWatch(session, 0, () => Date.now());
    cleanups.unshift(watch.close);
    expect(watch.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await fetch(watch.url);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await page.text()).toContain("QAJitsu watch");
    const progress = (await (await fetch(`${watch.url}progress.json`)).json()) as {
      state: string;
      cases: { id: string; status?: string; screenshot: boolean }[];
    };
    expect(progress.state).toBe("finished");
    expect(progress.cases.map((c) => [c.id, c.status, c.screenshot])).toEqual([
      ["TC-01", "PASSED", true],
      ["TC-02", "PASSED", false],
    ]);
    const png = await fetch(`${watch.url}live/TC-01.png`);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    for (const path of [
      "live/secret.txt",
      "live/..%2Frun.json",
      "run.json",
      "journal/events.jsonl",
      "env/app.env",
      "evidence/manifest.json",
    ])
      expect((await fetch(`${watch.url}${path}`)).status).toBe(404);
    expect((await fetch(`${watch.url}progress.json`, { method: "POST" })).status).toBe(405);
    expect(JSON.stringify(await readFile(join(dir, "results", "TC-01.json"), "utf8"))).toContain("passed");
  }, 240_000);
});
