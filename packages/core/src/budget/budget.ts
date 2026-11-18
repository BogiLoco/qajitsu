import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProjectConfig } from "../config/project-config.js";

/** The ledger file of a project, under its run root (REQ-FLOW-06/AC2). */
export const SPEND_LEDGER_FILE = "budget/spend.jsonl";

const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const common = {
  ts: z.iso.datetime(),
  project: z.string().min(1).max(100),
  ticket: z.string().min(1).max(40),
  ticketVersion: Digest,
  runId: z.string().min(1).max(80),
  stage: z.string().min(1).max(40),
};

/**
 * One entry of the spend ledger (REQ-FLOW-06/AC2): a model call or the active time of a finished command. Written by
 * code only; checked with this schema whenever it is read.
 */
export const SpendEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("model"),
    ...common,
    role: z.string().min(1).max(40),
    model: z.string().min(1).max(200),
    /** The cases the call worked for; empty for work shared by the ticket (analysis, plan, approval). */
    caseIds: z.array(z.string().min(1).max(40)).max(1000),
    /** True when the call's cost is split equally between its cases (the auditor's review, REQ-FLOW-06/AC3). */
    apportioned: z.boolean().optional(),
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    /** USD; `null` for a paid model without a known price (REQ-FLOW-06/AC7). A local model costs 0. */
    costUsd: z.number().nonnegative().nullable(),
  }),
  z.strictObject({ kind: z.literal("runtime"), ...common, activeMs: z.number().int().nonnegative() }),
]);
/** One ledger entry. */
export type SpendEntry = z.infer<typeof SpendEntrySchema>;

/** What a scope has spent. */
export interface SpendTotals {
  /** USD of the calls with a known price. */
  readonly costUsd: number;
  /** Calls of paid models without a price: their cost is not in `costUsd`. */
  readonly unpricedCalls: number;
  readonly tokens: number;
  readonly activeMs: number;
}

/** Budget scopes, from the narrowest. */
export type BudgetScope = "run" | "ticket" | "month";

/** Why work stops: the scope, the metric, what was spent of what limit (REQ-FLOW-06/AC5+AC6). */
export interface BudgetStop {
  readonly scope: BudgetScope;
  readonly metric: "cost" | "tokens" | "minutes";
  readonly limit: number;
  readonly spent: number;
  /** The calendar month, for the month scope. */
  readonly period?: string;
  readonly reason: string;
}

/** One formatter per time zone: a ledger of a year has many thousands of entries. */
const MONTH_FORMATS = new Map<string, Intl.DateTimeFormat>();

/**
 * The calendar month (`YYYY-MM`) of a time in a time zone (REQ-FLOW-06/AC3).
 *
 * @param at - The time.
 * @param timeZone - IANA name.
 */
export function monthOf(at: Date, timeZone: string): string {
  let format = MONTH_FORMATS.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" });
    MONTH_FORMATS.set(timeZone, format);
  }
  const parts = format.formatToParts(at);
  const year = parts.find((p) => p.type === "year")?.value ?? "0000";
  const month = parts.find((p) => p.type === "month")?.value ?? "00";
  return `${year}-${month}`;
}

/**
 * The version of a ticket's content (REQ-FLOW-06/AC4): the SHA-256 of its summary, description and acceptance
 * criteria, with line ends and surrounding whitespace normalised. Status, comments and labels are not part of it.
 */
export function ticketVersion(ticket: {
  readonly summary: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
}): string {
  const norm = (s: string) => s.replace(/\r\n?/g, "\n").trim();
  const canonical = JSON.stringify([
    norm(ticket.summary),
    norm(ticket.description),
    ticket.acceptanceCriteria.map(norm),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The spend of the entries that match: a ticket (optionally one version of it), and a calendar month.
 *
 * @param entries - Ledger entries.
 * @param query - What to sum; a month needs its time zone.
 */
export function sumSpend(
  entries: readonly SpendEntry[],
  query: {
    readonly ticket?: string;
    readonly ticketVersion?: string;
    readonly month?: string;
    readonly timeZone?: string;
  },
): SpendTotals {
  let costUsd = 0;
  let unpricedCalls = 0;
  let tokens = 0;
  let activeMs = 0;
  for (const e of entries) {
    if (query.ticket !== undefined && e.ticket !== query.ticket) continue;
    if (query.ticketVersion !== undefined && e.ticketVersion !== query.ticketVersion) continue;
    if (query.month !== undefined && monthOf(new Date(e.ts), query.timeZone ?? "UTC") !== query.month)
      continue;
    if (e.kind === "runtime") {
      activeMs += e.activeMs;
      continue;
    }
    tokens += e.inputTokens + e.cachedInputTokens + e.outputTokens;
    if (e.costUsd === null) unpricedCalls += 1;
    else costUsd += e.costUsd;
  }
  return { costUsd: Math.round(costUsd * 1e9) / 1e9, unpricedCalls, tokens, activeMs };
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Whether a budget stops work (REQ-FLOW-06/AC5+AC7): the first scope (ticket, then month) whose spend reached a
 * limit, or, before a call of a paid model without a price, the first ticket or month cost limit that could not be
 * kept.
 *
 * @param budget - `budget` of the project config.
 * @param spent - What the ticket version and the month spent so far.
 * @param context - The month's name, and the next call when checking before one.
 */
export function checkBudget(
  budget: ProjectConfig["budget"],
  spent: { readonly ticket: SpendTotals; readonly month: SpendTotals },
  context: {
    readonly period: string;
    readonly next?: { readonly model: string; readonly unpriced: boolean };
  },
): BudgetStop | undefined {
  if (context.next?.unpriced === true) {
    // The run's own limit keeps REQ-LLM-09: a missing price makes its cost unknown, it does not stop the run.
    const limits: [BudgetScope, number | undefined, number][] = [
      ["ticket", budget.ticket?.max_cost_usd, spent.ticket.costUsd],
      ["month", budget.month?.max_cost_usd, spent.month.costUsd],
    ];
    const hit = limits.find(([, limit]) => limit !== undefined);
    if (hit) {
      const [scope, limit, already] = hit;
      const ref = context.next.model;
      const slash = ref.indexOf("/");
      return {
        scope,
        metric: "cost",
        limit: limit ?? 0,
        spent: already,
        ...(scope === "month" ? { period: context.period } : {}),
        reason: `${ref} has no known price, so the ${scope} cost budget cannot be kept; declare cost_per_mtok under models.providers.${ref.slice(0, slash)}.models.${ref.slice(slash + 1)}`,
      };
    }
  }
  const scopes: [Exclude<BudgetScope, "run">, ProjectConfig["budget"]["ticket"], SpendTotals][] = [
    ["ticket", budget.ticket, spent.ticket],
    ["month", budget.month, spent.month],
  ];
  for (const [scope, limits, totals] of scopes) {
    if (!limits) continue;
    const where = scope === "ticket" ? "on this version of the ticket" : `in ${context.period}`;
    const checks: [BudgetStop["metric"], number | undefined, number, (n: number) => string][] = [
      ["cost", limits.max_cost_usd, totals.costUsd, usd],
      ["tokens", limits.max_tokens, totals.tokens, (n) => String(n)],
      ["minutes", limits.max_minutes, totals.activeMs / 60_000, (n) => n.toFixed(1)],
    ];
    for (const [metric, limit, value, show] of checks) {
      if (limit === undefined || value < limit) continue;
      const unit = metric === "tokens" ? " tokens" : metric === "minutes" ? " minutes" : "";
      return {
        scope,
        metric,
        limit,
        spent: Math.round(value * 100) / 100,
        ...(scope === "month" ? { period: context.period } : {}),
        reason: `${scope} budget reached: ${show(value)} of ${show(limit)}${unit} spent ${where}`,
      };
    }
  }
  return undefined;
}
