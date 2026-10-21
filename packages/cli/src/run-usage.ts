import { createUsageTracker, type UsageTracker } from "@qajitsu/agents";
import type { EventLog, RunWorkspace } from "@qajitsu/core";
import type { LoadedProject } from "./project.js";

/**
 * The usage tracker of one stage of a run (REQ-LLM-07, REQ-LLM-09/AC3+AC4): it starts from the tokens and the cost
 * the run's earlier stages recorded, applies the token budget and, unless `costBudget` is off, the run's cost budget.
 *
 * @param ws - The run.
 * @param project - Its project (budgets).
 * @param events - The run's event log.
 * @param options - `costBudget: false` for stages that stop between cases themselves (the author in `qj run`).
 */
export function runUsage(
  ws: RunWorkspace,
  project: LoadedProject,
  events: EventLog,
  options: { readonly costBudget?: boolean } = {},
): UsageTracker {
  return createUsageTracker({
    events,
    budget: project.config.models.token_budget,
    alreadyUsed: Number(ws.record.data["tokens"] ?? 0),
    alreadyCostUsd: Number(ws.record.data["costUsd"] ?? 0),
    alreadyCostKnown: ws.record.data["costUnknown"] !== true,
    ...(options.costBudget === false ? {} : { costBudgetUsd: project.config.budget.max_cost_usd }),
  });
}

/** Records the run's tokens and cost in `run.json`; an unknown cost is marked as such, never stored as 0. */
export async function saveRunUsage(ws: RunWorkspace, usage: UsageTracker): Promise<void> {
  const data: Record<string, unknown> = { ...ws.record.data };
  delete data["costUnknown"];
  await ws.update({
    data: {
      ...data,
      tokens: usage.total,
      costUsd: Number(usage.costUsd.toFixed(6)),
      ...(usage.costKnown ? {} : { costUnknown: true }),
    },
  });
}
