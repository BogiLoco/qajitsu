import type { Actor, EventLog } from "@qajitsu/core";
import type { ModelProfile } from "@qajitsu/models";
import { TokenBudgetExceededError } from "./errors.js";

/** Token usage of one model call. */
export interface CallUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Accumulates usage per run, journals it and enforces the token budget (REQ-LLM-07). */
export interface UsageTracker {
  /** Records one call; throws when the budget is exceeded. */
  record(stage: string, role: string, modelId: string, profile: ModelProfile, usage: CallUsage): void;
  /** Total tokens so far (input + output). */
  readonly total: number;
  /** Total estimated cost in USD, when prices are known. */
  readonly costUsd: number;
}

/**
 * Creates a usage tracker.
 *
 * @param options - Event log, optional budget and tokens already used by earlier stages of the run.
 */
export function createUsageTracker(options: {
  readonly events: EventLog;
  readonly budget?: number | undefined;
  readonly alreadyUsed?: number;
}): UsageTracker {
  let total = options.alreadyUsed ?? 0;
  let cost = 0;
  return {
    get total() {
      return total;
    },
    get costUsd() {
      return cost;
    },
    record(stage, role, modelId, profile, usage) {
      total += usage.inputTokens + usage.outputTokens;
      const price = profile.costPerMTok;
      const callCost =
        price === undefined
          ? undefined
          : (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
      if (callCost !== undefined) cost += callCost;
      const actor: Actor = { kind: "agent", name: role };
      options.events.emit(stage, actor, "model.usage", {
        role,
        model: modelId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(callCost === undefined ? {} : { costUsd: Number(callCost.toFixed(6)) }),
        runTotalTokens: total,
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
    },
  };
}
