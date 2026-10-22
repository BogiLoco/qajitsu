import { readFileSync } from "node:fs";
import { createUsageTracker, type UsageTracker } from "@qajitsu/agents";
import {
  AGENT_TRANSCRIPT_FILE,
  createTranscript,
  fileSink,
  type RunWorkspace,
  type TranscriptRecorder,
} from "@qajitsu/core";
import type { RunSession } from "./session.js";

/**
 * The agent transcript of a run (REQ-VER-16/AC2+AC3): masked with the run's masker, appended to
 * `journal/agents.jsonl`, numbered after the lines earlier stages wrote.
 */
export function runTranscript(
  session: Pick<RunSession, "ws" | "masker">,
  now: () => Date,
): TranscriptRecorder {
  const file = session.ws.path(...(AGENT_TRANSCRIPT_FILE.split("/") as [string, string]));
  let before = 0;
  try {
    before = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "").length;
  } catch {
    // No transcript yet.
  }
  return createTranscript({
    write: fileSink(file),
    mask: (v) => session.masker.maskJson(v),
    now,
    firstSeq: before + 1,
  });
}

/**
 * The usage tracker of one stage of a run (REQ-LLM-07, REQ-LLM-09/AC3+AC4): it starts from the tokens and the cost
 * the run's earlier stages recorded, applies the token budget and, unless `costBudget` is off, the run's cost budget.
 *
 * Every model call is also stored in the run's agent transcript (REQ-VER-16/AC2).
 *
 * @param session - The run, its project (budgets), event log and masker.
 * @param options - `costBudget: false` for stages that stop between cases themselves (the author in `qj run`).
 */
export function runUsage(
  session: Pick<RunSession, "ws" | "project" | "events" | "masker">,
  options: { readonly costBudget?: boolean; readonly now?: () => Date } = {},
): UsageTracker {
  const { ws, project, events } = session;
  return createUsageTracker({
    events,
    transcript: runTranscript(session, options.now ?? (() => new Date())),
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
