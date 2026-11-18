import { readFileSync } from "node:fs";
import { createUsageTracker, type UsageTracker } from "@qajitsu/agents";
import {
  AGENT_TRANSCRIPT_FILE,
  ConfigError,
  createTranscript,
  fileSink,
  fileSpendLedger,
  parseEventLines,
  SPEND_LEDGER_FILE,
  checkBudget,
  monthOf,
  sumSpend,
  ticketVersion,
  TicketSnapshotSchema,
  type ProjectConfig,
  type RunWorkspace,
  type TranscriptRecorder,
} from "@qajitsu/core";
import { runTiming } from "@qajitsu/report";
import { join } from "node:path";
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
 * The content version of the run's ticket (REQ-FLOW-06/AC4), from its snapshot.
 *
 * @throws ConfigError `BUDGET_TICKET_UNKNOWN` when there is no snapshot but a ticket or month budget needs it.
 */
function runTicketVersion(ws: RunWorkspace, budget: ProjectConfig["budget"]): string | undefined {
  try {
    return ticketVersion(
      TicketSnapshotSchema.parse(
        JSON.parse(readFileSync(ws.path("ticket", "ticket.json"), "utf8")) as unknown,
      ),
    );
  } catch {
    if (budget.ticket !== undefined || budget.month !== undefined)
      throw new ConfigError(
        "BUDGET_TICKET_UNKNOWN",
        `Run ${ws.runId} has no ticket snapshot, so its ticket and month budgets cannot be checked; fetch the ticket again.`,
        { run: ws.runId },
      );
    return undefined;
  }
}

/** The run's active time so far (REQ-NFR-11/AC2), from its journal. */
function runActiveMs(ws: RunWorkspace): number {
  let journal = "";
  try {
    journal = readFileSync(ws.path("journal", "events.jsonl"), "utf8");
  } catch {
    // No events yet: no active time.
  }
  return runTiming(parseEventLines(journal).events).activeMs;
}

/**
 * The check of the ticket and month active minutes before each case (REQ-FLOW-06/AC5): the ledger is read once,
 * the run's own active time since its last saved stage is added from its journal.
 *
 * @param session - The run and its project.
 * @param now - The command's clock, for the calendar month.
 * @returns A function giving the reason to stop, naming scope, spent minutes, limit and period, or undefined.
 * @throws BudgetError `LEDGER_INVALID` when the ledger cannot be read.
 */
export async function scopeMinutesStop(
  session: Pick<RunSession, "ws" | "project" | "events">,
  now: () => Date,
): Promise<() => string | undefined> {
  const { ws, project, events } = session;
  const { budget } = project.config;
  if (budget.ticket?.max_minutes === undefined && budget.month?.max_minutes === undefined)
    return () => undefined;
  const version = runTicketVersion(ws, budget) ?? "";
  const period = monthOf(now(), budget.time_zone);
  const entries = await fileSpendLedger(join(ws.root, SPEND_LEDGER_FILE)).read();
  const ticket = sumSpend(entries, { ticket: ws.ticket, ticketVersion: version });
  const month = sumSpend(entries, { month: period, timeZone: budget.time_zone });
  // What the ledger already holds of this run is not added twice.
  const counted = entries.reduce(
    (n, e) => n + (e.kind === "runtime" && e.runId === ws.runId ? e.activeMs : 0),
    0,
  );
  const minutesOnly = {
    time_zone: budget.time_zone,
    ...(budget.ticket?.max_minutes === undefined
      ? {}
      : { ticket: { max_minutes: budget.ticket.max_minutes } }),
    ...(budget.month?.max_minutes === undefined ? {} : { month: { max_minutes: budget.month.max_minutes } }),
  };
  let stopped: string | undefined;
  return () => {
    if (stopped !== undefined) return stopped;
    const extra = Math.max(0, runActiveMs(ws) - counted);
    const found = checkBudget(
      minutesOnly,
      {
        ticket: { ...ticket, activeMs: ticket.activeMs + extra },
        month: { ...month, activeMs: month.activeMs + extra },
      },
      { period },
    );
    if (found === undefined) return undefined;
    events.emit("run", { kind: "system", name: "orchestrator" }, "budget.exceeded", { ...found });
    stopped = found.reason;
    return stopped;
  };
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
  session: Pick<RunSession, "ws" | "project" | "events" | "masker" | "now">,
  options: { readonly costBudget?: boolean; readonly now?: () => Date } = {},
): UsageTracker {
  const { ws, project, events } = session;
  // REQ-FLOW-06/AC2+AC4: every call goes to the project's spend ledger, under the ticket's content version.
  const { budget } = project.config;
  const version = runTicketVersion(ws, budget);
  return createUsageTracker({
    events,
    transcript: runTranscript(session, options.now ?? session.now ?? (() => new Date())),
    now: options.now ?? session.now ?? (() => new Date()),
    budget: project.config.models.token_budget,
    alreadyUsed: Number(ws.record.data["tokens"] ?? 0),
    alreadyCostUsd: Number(ws.record.data["costUsd"] ?? 0),
    alreadyCostKnown: ws.record.data["costUnknown"] !== true,
    ...(options.costBudget === false ? {} : { costBudgetUsd: project.config.budget.max_cost_usd }),
    ...(version === undefined
      ? {}
      : {
          spend: {
            ledger: fileSpendLedger(join(ws.root, SPEND_LEDGER_FILE)),
            project: project.project?.slug ?? project.config.project,
            ticket: ws.ticket,
            ticketVersion: version,
            runId: ws.runId,
            budget,
          },
        }),
  });
}

/**
 * Records the run's tokens and cost in `run.json` (an unknown cost is marked as such, never stored as 0), adds the
 * active time this command added to the spend ledger (REQ-FLOW-06/AC2) and waits until every ledger entry is written.
 */
export async function saveRunUsage(ws: RunWorkspace, usage: UsageTracker, stage = "run"): Promise<void> {
  await usage.recordActiveTime(stage, runActiveMs(ws));
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

/**
 * Adds the active time a command added to the run to the spend ledger (REQ-FLOW-06/AC2), without touching
 * `run.json`: called when a command ends, also after the run was sealed and certified.
 *
 * @param session - The run and its project.
 * @param stage - The command's stage.
 * @param now - The command's clock.
 */
export async function saveActiveTime(
  session: Pick<RunSession, "ws" | "project">,
  stage: string,
  now: () => Date,
): Promise<void> {
  const { ws, project } = session;
  const version = runTicketVersion(ws, project.config.budget);
  if (version === undefined) return;
  await fileSpendLedger(join(ws.root, SPEND_LEDGER_FILE)).topUpActiveTime(
    {
      ts: now().toISOString(),
      project: project.project?.slug ?? project.config.project,
      ticket: ws.ticket,
      ticketVersion: version,
      runId: ws.runId,
      stage,
    },
    runActiveMs(ws),
  );
}
