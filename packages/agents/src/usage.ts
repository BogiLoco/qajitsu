import type { Actor, EventLog, ModelExchange, TranscriptRecorder } from "@qajitsu/core";
import { priceOn, type ModelProfile } from "@qajitsu/models";
import { TokenBudgetExceededError } from "./errors.js";

/** Token usage of one model call. */
export interface CallUsage {
  /** All input tokens, cached ones included. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input tokens read from the provider's prompt cache (REQ-LLM-11/AC1). */
  readonly cachedInputTokens?: number | undefined;
  /** Input tokens written to the provider's prompt cache. */
  readonly cacheWriteTokens?: number | undefined;
  /** Wall time of the call in milliseconds (REQ-NFR-11/AC1). */
  readonly durationMs?: number | undefined;
}

/** The usage of an AI SDK result, with the call's duration. */
export function callUsage(
  usage: {
    readonly inputTokens?: number | undefined;
    readonly outputTokens?: number | undefined;
    readonly inputTokenDetails?: {
      readonly cacheReadTokens?: number | undefined;
      readonly cacheWriteTokens?: number | undefined;
    };
  },
  startedAt?: number,
): CallUsage {
  const cached = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const written = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
    ...(written > 0 ? { cacheWriteTokens: written } : {}),
    ...(startedAt === undefined ? {} : { durationMs: Math.max(0, Date.now() - startedAt) }),
  };
}

/**
 * The cost of one call in USD, with the price valid on the day of the call (REQ-LLM-11/AC3). Cache reads and writes
 * without a price of their own are charged as input, so a cost is never lower than it may be.
 */
export function callCost(profile: ModelProfile, usage: CallUsage, day: Date): number | undefined {
  const price = priceOn(profile, day);
  if (price === undefined) return undefined;
  const cached = usage.cachedInputTokens ?? 0;
  const written = usage.cacheWriteTokens ?? 0;
  const plain = Math.max(0, usage.inputTokens - cached - written);
  return (
    (plain * price.input +
      cached * (price.cachedInput ?? price.input) +
      written * (price.cacheWrite ?? price.input) +
      usage.outputTokens * price.output) /
    1_000_000
  );
}

/** Accumulates usage per run, journals it and enforces the token budget (REQ-LLM-07). */
export interface UsageTracker {
  /**
   * Records one call; throws when the budget is exceeded. With `exchange`, the prompt and answer go to the transcript
   * and the journal keeps their hash (REQ-VER-16/AC2).
   */
  record(
    stage: string,
    role: string,
    modelId: string,
    profile: ModelProfile,
    usage: CallUsage,
    exchange?: ModelExchange,
  ): void;
  /** Total tokens so far (input + output). */
  readonly total: number;
  /** Estimated cost of the run so far in USD, earlier stages included (REQ-LLM-09/AC3). */
  readonly costUsd: number;
  /** False once any call of the run had no known price: the cost is then unknown, never shown as 0. */
  readonly costKnown: boolean;
}

/**
 * Creates a usage tracker.
 *
 * @param options - Event log, optional token and cost budgets, and what earlier stages of the run already used.
 */
export function createUsageTracker(options: {
  readonly events: EventLog;
  readonly budget?: number | undefined;
  readonly alreadyUsed?: number;
  /** Cost of the earlier stages of the run, from `run.json`. */
  readonly alreadyCostUsd?: number | undefined;
  /** False when an earlier stage had a call without a known price. */
  readonly alreadyCostKnown?: boolean | undefined;
  /** `budget.max_cost_usd`: once the run's cost reaches it, further model calls stop (REQ-LLM-09/AC4). */
  readonly costBudgetUsd?: number | undefined;
  /** Stores each model exchange (`journal/agents.jsonl`, REQ-VER-16/AC2). */
  readonly transcript?: TranscriptRecorder | undefined;
  /** Clock for the day a price applies to (REQ-LLM-11/AC3); the system clock by default. */
  readonly now?: (() => Date) | undefined;
}): UsageTracker {
  let total = options.alreadyUsed ?? 0;
  let cost = options.alreadyCostUsd ?? 0;
  let known = options.alreadyCostKnown ?? true;
  return {
    get total() {
      return total;
    },
    get costUsd() {
      return cost;
    },
    get costKnown() {
      return known;
    },
    record(stage, role, modelId, profile, usage, exchange) {
      total += usage.inputTokens + usage.outputTokens;
      const callCostUsd = callCost(profile, usage, (options.now ?? (() => new Date()))());
      if (callCostUsd !== undefined) cost += callCostUsd;
      else known = false;
      const actor: Actor = { kind: "agent", name: role };
      const stored = exchange && options.transcript ? options.transcript(exchange) : undefined;
      options.events.emit(stage, actor, "model.usage", {
        role,
        model: modelId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.cachedInputTokens ? { cachedInputTokens: usage.cachedInputTokens } : {}),
        ...(usage.cacheWriteTokens ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
        ...(usage.durationMs === undefined ? {} : { durationMs: usage.durationMs }),
        ...(callCostUsd === undefined ? {} : { costUsd: Number(callCostUsd.toFixed(6)) }),
        runTotalTokens: total,
        ...(stored ? { exchangeSha256: stored.sha256 } : {}),
      });
      if (options.budget !== undefined && total > options.budget) {
        options.events.emit(stage, { kind: "system", name: "orchestrator" }, "budget.exceeded", {
          budget: options.budget,
          total,
        });
        throw new TokenBudgetExceededError(
          "TOKEN_BUDGET_EXCEEDED",
          `Token budget of ${String(options.budget)} exceeded (${String(total)}).`,
          {
            budget: options.budget,
            total,
          },
        );
      }
      const limit = options.costBudgetUsd;
      if (limit !== undefined && callCostUsd !== undefined && cost >= limit) {
        const before = cost - callCostUsd;
        options.events.emit(stage, { kind: "system", name: "orchestrator" }, "budget.exceeded", {
          budgetUsd: limit,
          costUsd: Number(cost.toFixed(6)),
        });
        throw new TokenBudgetExceededError(
          "COST_BUDGET_EXCEEDED",
          `The run's cost budget of $${limit.toFixed(2)} was reached ($${before.toFixed(2)} → $${cost.toFixed(2)}).`,
          { budgetUsd: limit, costUsd: cost },
        );
      }
    },
  };
}
