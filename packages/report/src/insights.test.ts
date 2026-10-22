import type { RunEvent } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { costInsights, digestRun, isoWeek, weeklyCosts } from "./insights.js";

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
