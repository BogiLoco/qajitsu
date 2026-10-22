import type { RunEvent } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import {
  costInsights,
  digestRun,
  formatDuration,
  isoWeek,
  runTiming,
  stagesOverBudget,
  timeInsights,
  unionMs,
  weeklyCosts,
} from "./insights.js";

const event = (stage: string, name: string, details?: Record<string, unknown>): RunEvent => ({
  ts: "2026-10-22T10:00:00.000Z",
  run: "r",
  ticket: "DEMO-1",
  stage,
  actor: { kind: "system", name: "orchestrator" },
  event: name,
  ...(details ? { details } : {}),
});
const usage = (stage: string, role: string, cost?: number, more: Record<string, unknown> = {}) =>
  event(stage, "model.usage", {
    role,
    inputTokens: 1000,
    outputTokens: 100,
    ...(cost === undefined ? {} : { costUsd: cost }),
    ...more,
  });

const run = (ticket: string, runId: string, day: string, decision: string | undefined, events: RunEvent[]) =>
  digestRun({
    ticket,
    runId,
    createdAt: `${day}T09:00:00.000Z`,
    data: { results: {}, ...(decision ? { decision } : {}) },
    events,
    attemptsMs: [60_000, 30_000],
  });

describe("cost per verified ticket (REQ-LLM-11)", () => {
  it("REQ-LLM-11/AC2: a run's cost, per role, runner time and the stages that needed no model, from its records", () => {
    const d = run("DEMO-1", "r1", "2026-10-22", "NO-GO", [
      event("fetch", "stage.start"),
      usage("plan", "analyst", 0.1, { cachedInputTokens: 800, durationMs: 1200 }),
      usage("plan", "planner", 0.2, { durationMs: 3000 }),
      usage("run", "author", 0.3),
      event("run", "stage.end"),
      event("certificate", "certificate.issued"),
    ]);
    expect(d).toMatchObject({
      verified: true,
      executed: true,
      costKnown: true,
      runnerMs: 90_000,
      day: "2026-10-22",
    });
    expect(d.costUsd).toBeCloseTo(0.6, 9);
    expect(d.roles["analyst"]).toEqual({
      calls: 1,
      inputTokens: 1000,
      cachedInputTokens: 800,
      outputTokens: 100,
      costUsd: 0.1,
      costKnown: true,
      durationsMs: [1200],
    });
    // Bookkeeping after the verdict is not a stage of the work.
    expect([...d.stages].sort()).toEqual(["fetch", "plan", "run"]);
    expect([...d.stagesWithModel].sort()).toEqual(["plan", "run"]);
  });

  it("REQ-LLM-11/AC2: cost per verified ticket counts every run, also those that decided nothing; an unpriced call makes it a lower bound", () => {
    const runs = [
      run("DEMO-1", "r1", "2026-10-19", "NO DECISION", [usage("plan", "planner", 1)]),
      run("DEMO-1", "r2", "2026-10-20", "GO", [usage("plan", "planner", 1), usage("run", "author", 0.5)]),
      run("DEMO-2", "r3", "2026-10-21", "NO-GO", [
        usage("plan", "planner", 0.5),
        event("fetch", "stage.start"),
      ]),
      run("DEMO-3", "r4", "2026-10-21", undefined, [event("fetch", "stage.start")]),
    ];
    const all = costInsights(runs);
    expect(all).toMatchObject({ runs: 4, tickets: 3, verifiedTickets: 2, costUsd: 3, costKnown: true });
    expect(all.costPerVerifiedTicketUsd).toBe(1.5);
    expect(all.byRole).toEqual({ planner: { calls: 3, costUsd: 2.5 }, author: { calls: 1, costUsd: 0.5 } });
    expect(all.runnerMinutesPerTicket).toBe(2);
    // fetch (2x) of 6 stages needed no model.
    expect(all.stagesWithoutModelShare).toBeCloseTo(2 / 6, 6);
    const unknown = costInsights([run("DEMO-9", "r9", "2026-10-21", "GO", [usage("plan", "planner")])]);
    expect(unknown.costKnown).toBe(false);
    expect(costInsights([])).toMatchObject({
      runs: 0,
      runnerMinutesPerTicket: 0,
      stagesWithoutModelShare: 0,
    });
    expect(costInsights([]).costPerVerifiedTicketUsd).toBeUndefined();
  });

  it("REQ-LLM-11/AC4: costs per ISO week, oldest first", () => {
    expect(["2026-01-01", "2025-12-29", "2026-10-19", "2026-10-25", "2027-01-03"].map(isoWeek)).toEqual([
      "2026-W01",
      "2026-W01",
      "2026-W43",
      "2026-W43",
      "2026-W53",
    ]);
    const weeks = weeklyCosts([
      run("DEMO-2", "r3", "2026-10-26", "GO", [usage("plan", "planner", 2)]),
      run("DEMO-1", "r1", "2026-10-19", "GO", [usage("plan", "planner", 1)]),
    ]);
    expect(weeks.map((w) => [w.week, w.insights.costPerVerifiedTicketUsd])).toEqual([
      ["2026-W43", 1],
      ["2026-W44", 2],
    ]);
  });
});

describe("where the time of a run went (REQ-NFR-11)", () => {
  const at = (sec: number, stage: string, name: string, details?: Record<string, unknown>): RunEvent => ({
    ...event(stage, name, details),
    ts: new Date(Date.UTC(2026, 9, 22, 10, 0, sec)).toISOString(),
  });

  it("REQ-NFR-11/AC1+AC2: active time is split into model calls, environment, tests and QAJitsu's own work; idle time between commands is not counted", () => {
    const t = runTiming([
      at(0, "fetch", "stage.start"),
      at(2, "fetch", "stage.end"),
      at(10, "plan", "stage.start"),
      // Two overlapping model calls of 20 s each (ending at 30 s and 35 s): 25 s of model time.
      at(30, "plan", "model.usage", { role: "analyst", durationMs: 20_000 }),
      at(35, "plan", "model.usage", { role: "planner", durationMs: 20_000 }),
      at(40, "plan", "stage.end"),
      // A person approves an hour later: idle, not counted.
      at(3600, "approve", "plan.approved"),
      at(3700, "run", "stage.start"),
      at(3700, "run", "env.build"),
      at(3730, "run", "env.health"),
      // Two lanes run at the same time.
      at(3730, "run", "case.attempt.start", { caseId: "TC-01", attempt: 1, lane: "api" }),
      at(3732, "run", "case.attempt.start", { caseId: "TC-02", attempt: 1, lane: "web" }),
      at(3740, "run", "case.attempt.end", { caseId: "TC-01", attempt: 1, lane: "api" }),
      at(3750, "run", "case.attempt.end", { caseId: "TC-02", attempt: 1, lane: "web" }),
      at(3755, "run", "stage.end"),
      at(3760, "certificate", "certificate.issued"),
    ]);
    expect(t).toEqual({
      activeMs: (2 + 30 + 0 + 55) * 1000,
      modelMs: 25_000,
      environmentMs: 30_000,
      testsMs: 20_000,
      otherMs: (87 - 25 - 30 - 20) * 1000,
      stages: { fetch: [2000], plan: [30_000], approve: [0], run: [55_000] },
    });
  });

  it("REQ-NFR-11/AC2: a provided environment costs no environment time; an open stage ends at its last event; a revision is a second span", () => {
    const t = runTiming([
      at(0, "plan", "stage.start"),
      at(5, "plan", "stage.end"),
      at(10, "plan", "stage.start"),
      at(12, "plan", "stage.end"),
      at(20, "run", "stage.start"),
      at(25, "run", "env.health"),
      at(26, "run", "case.attempt.start", { caseId: "TC-01", attempt: 1 }),
      at(30, "run", "case.attempt.end", { caseId: "TC-01", attempt: 1 }),
      { ...at(31, "run", "x"), ts: "not a date" },
    ]);
    expect(t.stages).toEqual({ plan: [5000, 2000], run: [10_000] });
    expect(t.environmentMs).toBe(0);
    expect(t.testsMs).toBe(4000);
    expect(
      unionMs([
        [0, 10],
        [5, 15],
        [20, 20],
        [30, 25],
      ]),
    ).toBe(15);
  });

  it("REQ-NFR-11/AC3: a stage over its budget is reported with the measured time; project budgets override the defaults", () => {
    const timing = runTiming([at(0, "plan", "stage.start"), at(1300, "plan", "stage.end")]);
    expect(stagesOverBudget(timing, ["plan", "fetch"], {})).toEqual([
      { stage: "plan", ms: 1_300_000, budgetS: 1200 },
    ]);
    expect(stagesOverBudget(timing, ["plan"], { plan: 1800 })).toEqual([]);
    expect([42_000, 65_000, 3_720_000].map(formatDuration)).toEqual(["42s", "1m 05s", "1h 02m"]);
  });

  it("REQ-NFR-11/AC2+AC4: medians per run and stage, and stage medians per QAJitsu version and per week", () => {
    const runOf = (day: string, version: string, planSec: number) =>
      digestRun({
        ticket: "DEMO-1",
        runId: day,
        createdAt: `${day}T09:00:00.000Z`,
        data: { versions: { qajitsu: version } },
        events: [
          at(0, "plan", "stage.start"),
          at(planSec, "plan", "model.usage", { role: "planner", durationMs: planSec * 1000 }),
          at(planSec, "plan", "stage.end"),
        ],
        attemptsMs: [],
      });
    const insights = timeInsights([
      runOf("2026-10-19", "0.1.0", 40),
      runOf("2026-10-20", "0.1.0", 60),
      runOf("2026-10-27", "0.2.0", 20),
      digestRun({
        ticket: "X",
        runId: "x",
        createdAt: "2026-10-27T00:00:00Z",
        data: {},
        events: [],
        attemptsMs: [],
      }),
    ]);
    expect(insights.runs).toBe(3);
    expect(insights.perRun).toEqual({
      activeMs: 40_000,
      modelMs: 40_000,
      environmentMs: 0,
      testsMs: 0,
      otherMs: 0,
    });
    expect(insights.stages).toEqual({ plan: 40_000 });
    expect(insights.byVersion).toEqual({ "0.1.0": { plan: 50_000 }, "0.2.0": { plan: 20_000 } });
    expect(insights.byWeek).toEqual({ "2026-W43": { plan: 50_000 }, "2026-W44": { plan: 20_000 } });
    expect(timeInsights([]).perRun.activeMs).toBe(0);
  });
});
