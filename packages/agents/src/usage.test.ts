import { createEventLog, type RunEvent } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { TokenBudgetExceededError } from "./errors.js";
import { createUsageTracker } from "./usage.js";

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
});
