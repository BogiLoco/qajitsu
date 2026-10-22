import type { Actor, EventLog, ModelExchange, TranscriptRecorder } from "@qajitsu/core";
import type { ModelProfile } from "@qajitsu/models";
import { TokenBudgetExceededError } from "./errors.js";

/** Token usage of one model call. */
export interface CallUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
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
      const price = profile.costPerMTok;
      const callCost =
        price === undefined
          ? undefined
          : (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
      if (callCost !== undefined) cost += callCost;
      else known = false;
      const actor: Actor = { kind: "agent", name: role };
      const stored = exchange && options.transcript ? options.transcript(exchange) : undefined;
      options.events.emit(stage, actor, "model.usage", {
        role,
        model: modelId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(callCost === undefined ? {} : { costUsd: Number(callCost.toFixed(6)) }),
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
      if (limit !== undefined && callCost !== undefined && cost >= limit) {
        const before = cost - callCost;
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
