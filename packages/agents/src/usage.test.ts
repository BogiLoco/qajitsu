import { createEventLog, type RunEvent } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { TokenBudgetExceededError } from "./errors.js";
import { callCost, callUsage, createUsageTracker } from "./usage.js";
import { modelProfile } from "@qajitsu/models";

const priced = {
  tools: true,
  structuredOutput: true,
  vision: true,
  contextWindow: 200_000,
  costPerMTok: { input: 2, output: 10 },
};
const unpriced = { tools: true, structuredOutput: true, vision: true, contextWindow: 200_000 };
const log = () => {
  const events: RunEvent[] = [];
  return {
    events,
    log: createEventLog({
      ticket: "DEMO-1",
      run: "r",
      write: (line) => events.push(JSON.parse(line) as RunEvent),
      now: () => new Date(0),
      mask: (v) => v,
    }),
  };
};

describe("usage tracking in US dollars (REQ-LLM-09/AC3+AC4, REQ-LLM-07)", () => {
  it("REQ-LLM-09/AC3: cost adds up across the stages of a run; a call without a known price makes it unknown, never 0", () => {
    const { log: events } = log();
    const usage = createUsageTracker({ events, alreadyUsed: 1000, alreadyCostUsd: 0.5 });
    usage.record("plan", "planner", "anthropic/claude-sonnet-5-5", priced, {
      inputTokens: 100_000,
      outputTokens: 10_000,
    });
    expect(usage.costUsd).toBeCloseTo(0.5 + 0.2 + 0.1);
    expect(usage.costKnown).toBe(true);
    usage.record("plan", "planner", "openai/some-model", unpriced, { inputTokens: 10, outputTokens: 10 });
    expect(usage.costKnown).toBe(false);
    expect(usage.total).toBe(1000 + 110_000 + 20);
  });

  it("REQ-LLM-09/AC3: an earlier stage with an unknown cost keeps the run's cost unknown", () => {
    const { log: events } = log();
    const usage = createUsageTracker({ events, alreadyCostUsd: 0.1, alreadyCostKnown: false });
    usage.record("run", "author", "anthropic/claude-sonnet-5-5", priced, {
      inputTokens: 10,
      outputTokens: 10,
    });
    expect(usage.costKnown).toBe(false);
  });

  it("REQ-LLM-09/AC4: reaching the run's cost budget stops further model calls with COST_BUDGET_EXCEEDED, journaled", () => {
    const { log: events, events: lines } = log();
    const usage = createUsageTracker({ events, alreadyCostUsd: 4.5, costBudgetUsd: 5 });
    usage.record("plan", "analyst", "anthropic/claude-sonnet-5-5", priced, {
      inputTokens: 100_000,
      outputTokens: 0,
    });
    let error: unknown;
    try {
      usage.record("plan", "planner", "anthropic/claude-sonnet-5-5", priced, {
        inputTokens: 100_000,
        outputTokens: 20_000,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TokenBudgetExceededError);
    expect((error as TokenBudgetExceededError).code).toBe("COST_BUDGET_EXCEEDED");
    expect((error as Error).message).toBe("The run's cost budget of $5.00 was reached ($4.70 → $5.10).");
    expect(lines.find((e) => e.event === "budget.exceeded")?.details).toEqual({ budgetUsd: 5, costUsd: 5.1 });
  });

  it("REQ-LLM-11/AC1: cached input tokens are recorded per call and role, priced as cache reads when the price says so", () => {
    const { log: events, events: written } = log();
    const tracker = createUsageTracker({ events, now: () => new Date("2026-10-22T10:00:00Z") });
    const cached = { ...priced, costPerMTok: { input: 2, output: 10, cachedInput: 0.2 } };
    tracker.record("plan", "planner", "anthropic/claude-x", cached, {
      inputTokens: 1_000_000,
      cachedInputTokens: 800_000,
      outputTokens: 100_000,
      durationMs: 1234,
    });
    // 200k plain input at $2 + 800k cached at $0.20 + 100k output at $10.
    expect(tracker.costUsd).toBeCloseTo(0.4 + 0.16 + 1, 6);
    expect(written.at(-1)?.details).toMatchObject({
      role: "planner",
      model: "anthropic/claude-x",
      inputTokens: 1_000_000,
      cachedInputTokens: 800_000,
      outputTokens: 100_000,
      durationMs: 1234,
      costUsd: 1.56,
    });
    // Without a cache price the cached tokens cost what input costs: never less than they may.
    expect(
      callCost(priced, { inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 0 }, new Date()),
    ).toBe(2);
    expect(
      callUsage({
        inputTokens: 10,
        outputTokens: 2,
        inputTokenDetails: { cacheReadTokens: 6, cacheWriteTokens: 1 },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 6, cacheWriteTokens: 1 });
    expect(callUsage({}, Date.now()).durationMs).toBeGreaterThanOrEqual(0);
  });

  it("REQ-LLM-11/AC3: a configured price applies from its date; before it, the configured or built-in price", () => {
    const profile = modelProfile("anthropic", "claude-opus-5-5", {
      cost_per_mtok: { input: 5, output: 25 },
      prices: [
        { from: "2026-12-01", input: 3, output: 15, cached_input: 0.3 },
        { from: "2026-11-01", input: 4, output: 20 },
      ],
    });
    const usage = { inputTokens: 1_000_000, outputTokens: 0 };
    expect(callCost(profile, usage, new Date("2026-10-31T23:00:00Z"))).toBe(5);
    expect(callCost(profile, usage, new Date("2026-11-15T00:00:00Z"))).toBe(4);
    expect(callCost(profile, usage, new Date("2027-01-01T00:00:00Z"))).toBe(3);
    expect(
      callCost(profile, { ...usage, cachedInputTokens: 1_000_000 }, new Date("2027-01-01T00:00:00Z")),
    ).toBe(0.3);
    // The tracker charges each call with the price of its own day.
    let day = new Date("2026-10-31T12:00:00Z");
    const tracker = createUsageTracker({ events: log().log, now: () => day });
    tracker.record("run", "author", "anthropic/claude-opus-5-5", profile, usage);
    day = new Date("2026-11-02T12:00:00Z");
    tracker.record("run", "author", "anthropic/claude-opus-5-5", profile, usage);
    expect(tracker.costUsd).toBe(9);
  });
});
