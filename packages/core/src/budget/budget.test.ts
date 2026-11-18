import { describe, expect, it } from "vitest";
import { parseProjectConfig } from "../config/project-config.js";
import { checkBudget, monthOf, sumSpend, ticketVersion, type SpendEntry } from "./budget.js";

const base = {
  project: "shop",
  jira: { type: "file", tickets_dir: "t", project_key: "SHOP" },
  environments: { allowlist: ["http://localhost:3000"] },
};
const budgetOf = (budget: unknown) => parseProjectConfig({ ...base, budget }).budget;
const V1 = ticketVersion({
  summary: "Cancel an order",
  description: "Paid orders can be cancelled.",
  acceptanceCriteria: ["Refund"],
});
const call = (over: Partial<Extract<SpendEntry, { kind: "model" }>> = {}): SpendEntry => ({
  kind: "model",
  ts: "2026-11-10T10:00:00.000Z",
  project: "shop",
  ticket: "SHOP-1",
  ticketVersion: V1,
  runId: "20261110-100000-abcd",
  stage: "run",
  role: "author",
  model: "claude/claude-sonnet-5",
  caseIds: ["TC-01"],
  inputTokens: 1000,
  cachedInputTokens: 0,
  outputTokens: 200,
  costUsd: 0.5,
  ...over,
});

describe("cost budgets (REQ-FLOW-06)", () => {
  it("REQ-FLOW-06/AC1: ticket and month limits and the month's time zone parse with defaults; invalid values do not", () => {
    expect(budgetOf(undefined)).toEqual({ time_zone: "UTC" });
    expect(
      budgetOf({
        max_cost_usd: 5,
        ticket: { max_cost_usd: 20, max_minutes: 60 },
        month: { max_tokens: 10_000_000 },
        time_zone: "Europe/Warsaw",
      }),
    ).toEqual({
      max_cost_usd: 5,
      ticket: { max_cost_usd: 20, max_minutes: 60 },
      month: { max_tokens: 10_000_000 },
      time_zone: "Europe/Warsaw",
    });
    for (const bad of [
      { time_zone: "Mars/Olympus" },
      { ticket: { max_cost_usd: -1 } },
      { month: { max_tokens: 1.5 } },
      { ticket: { cost: 5 } },
    ])
      expect(() => budgetOf(bad), JSON.stringify(bad)).toThrow();
  });

  it("REQ-FLOW-06/AC3: a call belongs to the month of its own time in the project's time zone", () => {
    const lateOctober = new Date("2026-10-31T23:30:00Z");
    expect(monthOf(lateOctober, "UTC")).toBe("2026-10");
    expect(monthOf(lateOctober, "Europe/Warsaw")).toBe("2026-11");
    expect(monthOf(new Date("2026-01-01T04:00:00Z"), "America/New_York")).toBe("2025-12");
  });

  it("REQ-FLOW-06/AC4: a ticket's version changes with its summary, description or criteria, not with whitespace", () => {
    expect(
      ticketVersion({
        summary: "Cancel an order",
        description: "Paid orders can be cancelled.\r\n",
        acceptanceCriteria: [" Refund "],
      }),
    ).toBe(V1);
    expect(
      ticketVersion({
        summary: "Cancel an order",
        description: "Paid orders can be cancelled.",
        acceptanceCriteria: ["Refund", "Email"],
      }),
    ).not.toBe(V1);
    expect(
      ticketVersion({
        summary: "Cancel any order",
        description: "Paid orders can be cancelled.",
        acceptanceCriteria: ["Refund"],
      }),
    ).not.toBe(V1);
    expect(V1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("REQ-FLOW-06/AC3+AC4: spend is summed per ticket version, ticket and month; unpriced calls are counted, not priced", () => {
    const entries: SpendEntry[] = [
      call(),
      call({ ts: "2026-11-11T10:00:00.000Z", costUsd: 0.25, inputTokens: 100, outputTokens: 0 }),
      call({ ticketVersion: "b".repeat(64), costUsd: 1 }),
      call({ ticket: "SHOP-2", costUsd: 2 }),
      call({ ts: "2026-10-20T10:00:00.000Z", costUsd: 4 }),
      call({ costUsd: null }),
      {
        kind: "runtime",
        ts: "2026-11-10T11:00:00.000Z",
        project: "shop",
        ticket: "SHOP-1",
        ticketVersion: V1,
        runId: "r",
        stage: "run",
        activeMs: 60_000,
      },
    ];
    const version = sumSpend(entries, { ticket: "SHOP-1", ticketVersion: V1 });
    expect(version).toEqual({ costUsd: 4.75, unpricedCalls: 1, tokens: 1200 * 3 + 100, activeMs: 60_000 });
    const november = sumSpend(entries, { month: "2026-11", timeZone: "UTC" });
    expect(november.costUsd).toBe(3.75);
    expect(november.unpricedCalls).toBe(1);
    expect(sumSpend(entries, { ticket: "SHOP-2" }).costUsd).toBe(2);
  });

  it("REQ-FLOW-06/AC5: the first scope at its limit stops work, naming the scope, metric, spent amount, limit and period", () => {
    const budget = budgetOf({
      ticket: { max_cost_usd: 10, max_minutes: 30 },
      month: { max_cost_usd: 100, max_tokens: 1_000_000 },
    });
    const totals = (costUsd: number, tokens = 0, activeMs = 0) => ({
      costUsd,
      unpricedCalls: 0,
      tokens,
      activeMs,
    });
    expect(
      checkBudget(budget, { ticket: totals(9.99), month: totals(50) }, { period: "2026-11" }),
    ).toBeUndefined();
    expect(checkBudget(budget, { ticket: totals(10), month: totals(50) }, { period: "2026-11" })).toEqual({
      scope: "ticket",
      metric: "cost",
      limit: 10,
      spent: 10,
      reason: "ticket budget reached: $10.00 of $10.00 spent on this version of the ticket",
    });
    expect(
      checkBudget(budget, { ticket: totals(1, 0, 31 * 60_000), month: totals(50) }, { period: "2026-11" })
        ?.metric,
    ).toBe("minutes");
    expect(
      checkBudget(budget, { ticket: totals(1), month: totals(5, 1_000_000) }, { period: "2026-11" }),
    ).toMatchObject({
      scope: "month",
      metric: "tokens",
      period: "2026-11",
      reason: "month budget reached: 1000000 of 1000000 tokens spent in 2026-11",
    });
    // No limits: nothing stops.
    expect(
      checkBudget(
        budgetOf(undefined),
        { ticket: totals(1e6, 1e9), month: totals(1e6) },
        { period: "2026-11" },
      ),
    ).toBeUndefined();
  });

  it("REQ-FLOW-06/AC7: a paid model without a price is refused under a ticket or month cost limit; a local model costs nothing", () => {
    const zero = { costUsd: 0, unpricedCalls: 0, tokens: 0, activeMs: 0 };
    const stop = checkBudget(
      budgetOf({ month: { max_cost_usd: 100 } }),
      { ticket: zero, month: zero },
      { period: "2026-11", next: { model: "gw/inhouse", unpriced: true } },
    );
    expect(stop).toEqual({
      scope: "month",
      metric: "cost",
      limit: 100,
      spent: 0,
      period: "2026-11",
      reason:
        "gw/inhouse has no known price, so the month cost budget cannot be kept; declare cost_per_mtok under models.providers.gw.models.inhouse",
    });
    // The run's own limit keeps REQ-LLM-09: its cost becomes unknown, the call is not refused.
    expect(
      checkBudget(
        budgetOf({ max_cost_usd: 5 }),
        { ticket: zero, month: zero },
        { period: "2026-11", next: { model: "gw/inhouse", unpriced: true } },
      ),
    ).toBeUndefined();
    // Without any cost limit an unpriced model runs; a token limit alone does not need a price.
    expect(
      checkBudget(
        budgetOf({ month: { max_tokens: 1000 } }),
        { ticket: zero, month: zero },
        { period: "2026-11", next: { model: "gw/inhouse", unpriced: true } },
      ),
    ).toBeUndefined();
  });
});
