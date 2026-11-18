import { parseProjectConfig, type SpendEntry } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { budgetReport, budgetStatusLines, formatBudgetReport } from "./budget.js";

const budgetOf = (budget: unknown) =>
  parseProjectConfig({
    project: "shop",
    jira: { type: "file", tickets_dir: "t", project_key: "SHOP" },
    environments: { allowlist: ["http://localhost:3000"] },
    budget,
  }).budget;
const V1 = "a".repeat(64);
const V2 = "b".repeat(64);
const call = (over: Partial<Extract<SpendEntry, { kind: "model" }>>): SpendEntry => ({
  kind: "model",
  ts: "2026-11-10T10:00:00.000Z",
  project: "shop",
  ticket: "SHOP-1",
  ticketVersion: V1,
  runId: "r1",
  stage: "run",
  role: "author",
  model: "claude/sonnet",
  caseIds: [],
  inputTokens: 1000,
  cachedInputTokens: 0,
  outputTokens: 0,
  costUsd: 1,
  ...over,
});
const ledger: SpendEntry[] = [
  call({ stage: "plan", role: "planner" }),
  call({ ts: "2026-11-11T10:00:00.000Z", caseIds: ["TC-01"], costUsd: 2 }),
  // The auditor's call is shared equally by the two cases it reviewed.
  call({
    ts: "2026-11-11T11:00:00.000Z",
    role: "auditor",
    model: "claude/haiku",
    caseIds: ["TC-01", "TC-02"],
    apportioned: true,
    costUsd: 1,
  }),
  // A newer version of the ticket: its window starts here.
  call({ ts: "2026-11-12T10:00:00.000Z", ticketVersion: V2, caseIds: ["TC-01"], costUsd: 4 }),
  call({ ts: "2026-11-12T11:00:00.000Z", ticket: "SHOP-2", model: "gw/inhouse", costUsd: null }),
  call({ ts: "2026-10-30T10:00:00.000Z", costUsd: 50 }),
  {
    kind: "runtime",
    ts: "2026-11-12T12:00:00.000Z",
    project: "shop",
    ticket: "SHOP-1",
    ticketVersion: V2,
    runId: "r2",
    stage: "run",
    activeMs: 30 * 60_000,
  },
];

describe("qj budget (REQ-FLOW-06/AC9)", () => {
  it("REQ-FLOW-06/AC9: spend of the month against every limit, the most expensive tickets and cases, calls without a price", () => {
    const r = budgetReport(
      ledger,
      budgetOf({ month: { max_cost_usd: 16, max_tokens: 10_000, max_minutes: 60 } }),
      {
        period: "2026-11",
      },
    );
    expect(r.month).toMatchObject({
      costUsd: 8,
      tokens: 5000,
      calls: 5,
      unpricedCalls: 1,
      activeMinutes: 30,
    });
    expect(r.limits).toEqual([
      { scope: "month", metric: "cost", spent: 8, limit: 16, percent: 50, atLeast: true },
      { scope: "month", metric: "tokens", spent: 5000, limit: 10_000, percent: 50, atLeast: false },
      { scope: "month", metric: "minutes", spent: 30, limit: 60, percent: 50, atLeast: false },
    ]);
    expect(r.tickets.map((t) => [t.key, t.costUsd])).toEqual([
      ["SHOP-1", 8],
      ["SHOP-2", 0],
    ]);
    expect(r.cases.map((c) => [c.key, c.costUsd])).toEqual([
      ["SHOP-1 TC-01", 6.5],
      ["SHOP-1 TC-02", 0.5],
    ]);
    expect(r.unpriced).toEqual([{ model: "gw/inhouse", calls: 1 }]);
    const text = formatBudgetReport(r);
    // A missing price is never shown as within budget or as $0.
    expect(text).toContain("month cost: at least $8.00 of $16.00 (≥ 50%)");
    expect(text).toContain("SHOP-2: at least $0.00 (1 call(s) without a price)");
    expect(text).toContain("gw/inhouse: 1 call(s)");
  });

  it("REQ-FLOW-06/AC4+AC9: --ticket breaks the current version down per case, shared stage, role, model and stage; earlier versions stay listed", () => {
    const r = budgetReport(ledger, budgetOf({ ticket: { max_cost_usd: 5 } }), {
      period: "2026-11",
      ticket: "SHOP-1",
    });
    const t = r.ticket;
    expect(t?.version).toBe(V2);
    expect(t?.versions.map((v) => [v.key, v.costUsd, v.first])).toEqual([
      [V1, 54, "2026-10-30T10:00:00.000Z"],
      [V2, 4, "2026-11-12T10:00:00.000Z"],
    ]);
    expect(r.limits).toContainEqual({
      scope: "ticket",
      metric: "cost",
      spent: 4,
      limit: 5,
      percent: 80,
      atLeast: false,
    });
    expect(t?.cases.map((c) => c.key)).toEqual(["TC-01"]);
    const v1 = budgetReport(
      ledger.filter((e) => e.ticketVersion === V1),
      budgetOf({}),
      {
        period: "2026-11",
        ticket: "SHOP-1",
      },
    ).ticket;
    expect(v1?.shared.map((g) => [g.key, g.costUsd])).toEqual([
      ["run", 50],
      ["plan", 1],
    ]);
    expect(v1?.byRole.map((g) => g.key)).toEqual(["author", "auditor", "planner"]);
    expect(v1?.byModel.map((g) => g.key)).toEqual(["claude/sonnet", "claude/haiku"]);
  });

  it("REQ-FLOW-06/AC9: qj status shows the month's line and the tickets at 80% or more of their budget", () => {
    expect(budgetStatusLines(ledger, budgetOf({}), new Date("2026-11-18T10:00:00Z"))).toEqual([]);
    expect(
      budgetStatusLines(
        ledger,
        budgetOf({ ticket: { max_cost_usd: 5 }, month: { max_cost_usd: 100 } }),
        new Date("2026-11-18T10:00:00Z"),
      ),
    ).toEqual([
      "Budget 2026-11: cost at least $8.00 of $100.00 (≥ 8%)",
      "Tickets at 80% or more of their budget: SHOP-1 (80% cost)",
    ]);
  });
});
