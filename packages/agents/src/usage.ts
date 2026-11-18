import {
  BudgetError,
  checkBudget,
  monthOf,
  sumSpend,
  type Actor,
  type BudgetStop,
  type EventLog,
  type ModelExchange,
  type ProjectConfig,
  type SpendEntry,
  type SpendLedger,
  type SpendTotals,
  type TranscriptRecorder,
} from "@qajitsu/core";
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

/** Which cases a call worked for (REQ-FLOW-06/AC3); none for work the ticket shares (analysis, plan). */
export interface CallAttribution {
  readonly caseIds: readonly string[];
  /** The call reviewed several cases at once (the auditor): its cost is split equally between them. */
  readonly apportioned?: boolean;
}

/** Accumulates usage per run, journals it and enforces the token and cost budgets (REQ-LLM-07, REQ-FLOW-06). */
export interface UsageTracker {
  /**
   * Checks the ticket and month budgets with what every run of the project spent so far, and refuses a paid model
   * without a price under a cost limit, before a call is sent (REQ-FLOW-06/AC5+AC7).
   *
   * @throws {TokenBudgetExceededError} `TICKET_BUDGET_EXCEEDED`, `MONTH_BUDGET_EXCEEDED`, `UNKNOWN_PRICE_UNDER_BUDGET`.
   */
  beforeCall(stage: string, role: string, modelId: string, profile: ModelProfile): Promise<void>;
  /**
   * Records one call; throws when a budget is exceeded. With `exchange`, the prompt and answer go to the transcript
   * and the journal keeps their hash (REQ-VER-16/AC2); `attribution` names the cases it worked for (REQ-FLOW-06/AC3).
   */
  record(
    stage: string,
    role: string,
    modelId: string,
    profile: ModelProfile,
    usage: CallUsage,
    exchange?: ModelExchange,
    attribution?: CallAttribution,
  ): void;
  /**
   * Brings the run's active time in the spend ledger up to `runActiveMs`, after every call of this tracker is written
   * (REQ-FLOW-06/AC2). Without a ledger it does nothing.
   */
  recordActiveTime(stage: string, runActiveMs: number): Promise<void>;
  /** Waits until every ledger entry of this tracker is written. */
  flush(): Promise<void>;
  /** The ticket or month budget that stopped work, once one did. */
  readonly stopped: BudgetStop | undefined;
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
  /** The project's spend ledger and the ticket and month budgets (REQ-FLOW-06); without it only the run is limited. */
  readonly spend?:
    | {
        readonly ledger: SpendLedger;
        readonly project: string;
        readonly ticket: string;
        readonly ticketVersion: string;
        readonly runId: string;
        readonly budget: ProjectConfig["budget"];
      }
    | undefined;
}): UsageTracker {
  let total = options.alreadyUsed ?? 0;
  let cost = options.alreadyCostUsd ?? 0;
  let known = options.alreadyCostKnown ?? true;
  const clock = options.now ?? (() => new Date());
  const spend = options.spend;
  // The ticket and month scopes are checked against the ledger; the run's own cost limit is the run budget above.
  // The ledger is read before a call only where a ticket or month limit makes it matter; it is always written.
  const limited =
    spend !== undefined && (spend.budget.ticket !== undefined || spend.budget.month !== undefined);
  const scoped: ProjectConfig["budget"] | undefined = limited
    ? { ...spend.budget, max_cost_usd: options.costBudgetUsd }
    : options.costBudgetUsd === undefined
      ? undefined
      : { time_zone: "UTC", max_cost_usd: options.costBudgetUsd };
  let pending: Promise<void> = Promise.resolve();
  // A failed append is kept and thrown by flush(), never left as an unhandled rejection (REQ-FLOW-06/AC2).
  let failure: Error | undefined;
  const flush = async (): Promise<void> => {
    await pending;
    if (failure !== undefined) throw failure;
  };
  const enqueue = (entry: SpendEntry, ledger: SpendLedger) => {
    pending = pending
      .then(() => ledger.append(entry))
      .catch((e: unknown) => {
        failure ??=
          e instanceof Error
            ? e
            : new BudgetError(
                "LEDGER_WRITE_FAILED",
                `The spend ledger could not be written: ${String(e)}`,
                {},
              );
      });
  };
  let base: { ticket: SpendTotals; month: SpendTotals } = {
    ticket: { costUsd: 0, unpricedCalls: 0, tokens: 0, activeMs: 0 },
    month: { costUsd: 0, unpricedCalls: 0, tokens: 0, activeMs: 0 },
  };
  let sinceRead: SpendEntry[] = [];
  let stopped: BudgetStop | undefined;
  const add = (a: SpendTotals, b: SpendTotals): SpendTotals => ({
    costUsd: a.costUsd + b.costUsd,
    unpricedCalls: a.unpricedCalls + b.unpricedCalls,
    tokens: a.tokens + b.tokens,
    activeMs: a.activeMs + b.activeMs,
  });
  const stop = (stage: string, found: BudgetStop, code: string): never => {
    stopped = found;
    options.events.emit(stage, { kind: "system", name: "orchestrator" }, "budget.exceeded", { ...found });
    throw new TokenBudgetExceededError(code, found.reason, { ...found });
  };
  const codeOf = (found: BudgetStop, unpriced: boolean): string =>
    unpriced && found.metric === "cost" && found.reason.includes("no known price")
      ? "UNKNOWN_PRICE_UNDER_BUDGET"
      : found.scope === "month"
        ? "MONTH_BUDGET_EXCEEDED"
        : found.scope === "ticket"
          ? "TICKET_BUDGET_EXCEEDED"
          : "COST_BUDGET_EXCEEDED";
  const periodNow = () => monthOf(clock(), spend?.budget.time_zone ?? "UTC");
  const totalsOf = (entries: readonly SpendEntry[], period: string) =>
    spend
      ? {
          ticket: sumSpend(entries, { ticket: spend.ticket, ticketVersion: spend.ticketVersion }),
          month: sumSpend(entries, { month: period, timeZone: spend.budget.time_zone }),
        }
      : base;
  return {
    get stopped() {
      return stopped;
    },
    async beforeCall(stage, _role, modelId, profile) {
      if (!scoped) return;
      const unpriced = priceOn(profile, clock()) === undefined;
      const period = periodNow();
      if (spend && limited) {
        await flush();
        base = totalsOf(await spend.ledger.read(), period);
        sinceRead = [];
      }
      const found = checkBudget(scoped, base, { period, next: { model: modelId, unpriced } });
      if (found) stop(stage, found, codeOf(found, unpriced));
    },
    async recordActiveTime(stage, runActiveMs) {
      await flush();
      if (!spend) return;
      await spend.ledger.topUpActiveTime(
        {
          ts: clock().toISOString(),
          project: spend.project,
          ticket: spend.ticket,
          ticketVersion: spend.ticketVersion,
          runId: spend.runId,
          stage,
        },
        runActiveMs,
      );
    },
    flush,
    get total() {
      return total;
    },
    get costUsd() {
      return cost;
    },
    get costKnown() {
      return known;
    },
    record(stage, role, modelId, profile, usage, exchange, attribution) {
      total += usage.inputTokens + usage.outputTokens;
      const callCostUsd = callCost(profile, usage, clock());
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
        ...(attribution && attribution.caseIds.length > 0
          ? { caseIds: [...attribution.caseIds], ...(attribution.apportioned ? { apportioned: true } : {}) }
          : {}),
      });
      if (spend) {
        const cached = usage.cachedInputTokens ?? 0;
        const entry: SpendEntry = {
          kind: "model",
          ts: clock().toISOString(),
          project: spend.project,
          ticket: spend.ticket,
          ticketVersion: spend.ticketVersion,
          runId: spend.runId,
          stage,
          role,
          model: modelId,
          caseIds: [...(attribution?.caseIds ?? [])],
          ...(attribution?.apportioned ? { apportioned: true } : {}),
          inputTokens: Math.max(0, usage.inputTokens - cached),
          cachedInputTokens: cached,
          outputTokens: usage.outputTokens,
          // The journal's precision, so the two can be compared call by call (REQ-FLOW-06/AC2).
          costUsd: callCostUsd === undefined ? null : Number(callCostUsd.toFixed(6)),
        };
        sinceRead.push(entry);
        enqueue(entry, spend.ledger);
      }
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
      // After the run's own token budget, so a call over both is reported as the run's (REQ-LLM-07).
      if (spend && limited) {
        const period = periodNow();
        const now = totalsOf(sinceRead, period);
        const found = checkBudget(
          { ...spend.budget, max_cost_usd: undefined },
          { ticket: add(base.ticket, now.ticket), month: add(base.month, now.month) },
          { period },
        );
        if (found) stop(stage, found, codeOf(found, false));
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

/**
 * Records one model call and waits until its ledger entry is written, also when the call stopped a budget
 * (REQ-FLOW-06/AC2): no spend is left unwritten when the command ends right after.
 *
 * @param usage - The stage's usage tracker.
 * @param args - The arguments of {@link UsageTracker.record}.
 * @throws TokenBudgetExceededError when the call exhausted a budget; the ledger's error when it could not be written.
 */
export async function recordCall(
  usage: UsageTracker,
  ...args: Parameters<UsageTracker["record"]>
): Promise<void> {
  try {
    usage.record(...args);
  } finally {
    await usage.flush();
  }
}

/** Codes of the ticket and month budget stops (REQ-FLOW-06/AC5), as opposed to the run's own token or cost budget. */
export const SCOPE_BUDGET_CODES: ReadonlySet<string> = new Set([
  "TICKET_BUDGET_EXCEEDED",
  "MONTH_BUDGET_EXCEEDED",
  "UNKNOWN_PRICE_UNDER_BUDGET",
]);

/**
 * Whether an error is a ticket or month budget stop (REQ-FLOW-06/AC5).
 *
 * @param error - Anything thrown.
 * @returns True for a {@link TokenBudgetExceededError} with one of {@link SCOPE_BUDGET_CODES}.
 */
export function isScopeBudgetStop(error: unknown): error is TokenBudgetExceededError {
  return error instanceof TokenBudgetExceededError && SCOPE_BUDGET_CODES.has(error.code);
}
