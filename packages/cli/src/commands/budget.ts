import { join } from "node:path";
import {
  ConfigError,
  fileSpendLedger,
  monthOf,
  QajitsuError,
  SPEND_LEDGER_FILE,
  TicketKeySchema,
  type ProjectConfig,
  type SpendEntry,
} from "@qajitsu/core";
import type { RuntimePorts } from "../adapters.js";
import { ledgerProblems, rebuildLedger } from "../budget-ledger.js";
import { loadProject } from "../project.js";
import type { CommandIO } from "./fetch.js";
import { rootOf } from "./runs.js";

/** Spend of one group (a ticket, a case, a role, a model, a stage). */
export interface SpendGroup {
  readonly key: string;
  readonly costUsd: number;
  /** Calls without a price: the cost above is a lower bound when this is not 0 (REQ-FLOW-06/AC7). */
  readonly unpricedCalls: number;
  readonly tokens: number;
  readonly calls: number;
}

/** One limit against what was spent (REQ-FLOW-06/AC9). */
export interface LimitRow {
  readonly scope: "month" | "ticket";
  readonly metric: "cost" | "tokens" | "minutes";
  readonly spent: number;
  readonly limit: number;
  readonly percent: number;
  /** The spent cost misses calls without a price: it is at least this much. */
  readonly atLeast: boolean;
}

/** What `qj budget` shows, computed by code from the ledger (INV-6). */
export interface BudgetReport {
  readonly period: string;
  readonly timeZone: string;
  readonly limits: readonly LimitRow[];
  readonly month: SpendGroup & { readonly activeMinutes: number };
  readonly tickets: readonly SpendGroup[];
  readonly cases: readonly SpendGroup[];
  readonly unpriced: readonly { readonly model: string; readonly calls: number }[];
  readonly ticket?: {
    readonly key: string;
    readonly version: string;
    readonly versions: readonly (SpendGroup & { readonly first: string })[];
    readonly cases: readonly SpendGroup[];
    readonly shared: readonly SpendGroup[];
    readonly byRole: readonly SpendGroup[];
    readonly byModel: readonly SpendGroup[];
    readonly byStage: readonly SpendGroup[];
  };
}

const TOP = 5;

/** Groups model calls; a call for several cases is shared equally between them (the auditor's, AC3). */
function group(
  entries: readonly SpendEntry[],
  keys: (e: Extract<SpendEntry, { kind: "model" }>) => string[],
) {
  const out = new Map<string, { costUsd: number; unpricedCalls: number; tokens: number; calls: number }>();
  for (const e of entries) {
    if (e.kind !== "model") continue;
    const ks = keys(e);
    for (const key of ks) {
      const g = out.get(key) ?? { costUsd: 0, unpricedCalls: 0, tokens: 0, calls: 0 };
      const share = 1 / ks.length;
      g.costUsd += (e.costUsd ?? 0) * share;
      g.unpricedCalls += e.costUsd === null ? 1 : 0;
      g.tokens += (e.inputTokens + e.cachedInputTokens + e.outputTokens) * share;
      g.calls += 1;
      out.set(key, g);
    }
  }
  return [...out.entries()]
    .map(([key, g]) => ({ key, ...g, tokens: Math.round(g.tokens) }))
    .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens || a.key.localeCompare(b.key));
}

const total = (entries: readonly SpendEntry[]): SpendGroup & { activeMinutes: number } => {
  const [all] = group(entries, () => ["all"]);
  const activeMs = entries.reduce((n, e) => n + (e.kind === "runtime" ? e.activeMs : 0), 0);
  return {
    ...(all ?? { key: "all", costUsd: 0, unpricedCalls: 0, tokens: 0, calls: 0 }),
    activeMinutes: activeMs / 60_000,
  };
};

const rows = (
  scope: LimitRow["scope"],
  limits: NonNullable<ProjectConfig["budget"]["month"]> | undefined,
  spent: SpendGroup & { activeMinutes: number },
): LimitRow[] =>
  (
    [
      ["cost", limits?.max_cost_usd, spent.costUsd],
      ["tokens", limits?.max_tokens, spent.tokens],
      ["minutes", limits?.max_minutes, spent.activeMinutes],
    ] as const
  ).flatMap(([metric, limit, value]) =>
    limit === undefined
      ? []
      : [
          {
            scope,
            metric,
            spent: value,
            limit,
            percent: Math.round((value / limit) * 1000) / 10,
            atLeast: metric === "cost" && spent.unpricedCalls > 0,
          },
        ],
  );

/** The ticket's current version: the one of its latest ledger entry. */
const currentVersion = (entries: readonly SpendEntry[], ticket: string): string | undefined =>
  entries
    .filter((e) => e.ticket === ticket)
    .reduce<SpendEntry | undefined>((a, e) => (a === undefined || e.ts >= a.ts ? e : a), undefined)
    ?.ticketVersion;

/**
 * Spend against every limit for a month, and optionally one ticket's breakdown (REQ-FLOW-06/AC9).
 *
 * @param entries - The ledger.
 * @param budget - The project's budgets.
 * @param options - The month (`YYYY-MM` in `budget.time_zone`) and the ticket to break down.
 */
export function budgetReport(
  entries: readonly SpendEntry[],
  budget: ProjectConfig["budget"],
  options: { readonly period: string; readonly ticket?: string | undefined },
): BudgetReport {
  const inMonth = entries.filter((e) => monthOf(new Date(e.ts), budget.time_zone) === options.period);
  const month = total(inMonth);
  const limits = [...rows("month", budget.month, month)];
  const unpriced = group(
    inMonth.filter((e) => e.kind === "model" && e.costUsd === null),
    (e) => [e.model],
  ).map((g) => ({ model: g.key, calls: g.calls }));
  let ticket: BudgetReport["ticket"];
  if (options.ticket !== undefined) {
    const key = options.ticket;
    const all = entries.filter((e) => e.ticket === key);
    const version = currentVersion(entries, key) ?? "";
    const current = all.filter((e) => e.ticketVersion === version);
    limits.push(...rows("ticket", budget.ticket, total(current)));
    const firstOf = (v: string) =>
      all
        .filter((e) => e.ticketVersion === v)
        .map((e) => e.ts)
        .sort()[0] ?? "";
    ticket = {
      key,
      version,
      versions: group(all, (e) => [e.ticketVersion])
        .map((g) => ({ ...g, first: firstOf(g.key) }))
        .sort((a, b) => a.first.localeCompare(b.first)),
      cases: group(current, (e) => [...e.caseIds]),
      shared: group(
        current.filter((e) => e.kind === "model" && e.caseIds.length === 0),
        (e) => [e.stage],
      ),
      byRole: group(current, (e) => [e.role]),
      byModel: group(current, (e) => [e.model]),
      byStage: group(current, (e) => [e.stage]),
    };
  }
  return {
    period: options.period,
    timeZone: budget.time_zone,
    limits,
    month,
    tickets: group(inMonth, (e) => [e.ticket]).slice(0, TOP),
    cases: group(inMonth, (e) => e.caseIds.map((c) => `${e.ticket} ${c}`)).slice(0, TOP),
    unpriced,
    ...(ticket ? { ticket } : {}),
  };
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const cost = (g: SpendGroup) =>
  g.unpricedCalls > 0
    ? `at least ${usd(g.costUsd)} (${String(g.unpricedCalls)} call(s) without a price)`
    : usd(g.costUsd);
const value = (metric: LimitRow["metric"], n: number) =>
  metric === "cost" ? usd(n) : metric === "tokens" ? String(Math.round(n)) : `${n.toFixed(1)} min`;
const groupLine = (g: SpendGroup) =>
  `  ${g.key}: ${cost(g)}, ${String(g.tokens)} tokens, ${String(g.calls)} call(s)`;

/**
 * The report as text.
 *
 * @param r - The report.
 */
export function formatBudgetReport(r: BudgetReport): string {
  const lines = [
    `Spend in ${r.period} (${r.timeZone}): ${cost(r.month)}, ${String(r.month.tokens)} tokens, ${r.month.activeMinutes.toFixed(1)} active min, ${String(r.month.calls)} model call(s)`,
  ];
  if (r.limits.length === 0) lines.push("No ticket or month limit is set (budget.ticket, budget.month).");
  for (const l of r.limits)
    lines.push(
      `  ${l.scope} ${l.metric}: ${l.atLeast ? "at least " : ""}${value(l.metric, l.spent)} of ${value(l.metric, l.limit)} (${l.atLeast ? "≥ " : ""}${String(l.percent)}%)`,
    );
  if (r.tickets.length > 0) lines.push("Most expensive tickets:", ...r.tickets.map(groupLine));
  if (r.cases.length > 0) lines.push("Most expensive cases:", ...r.cases.map(groupLine));
  if (r.unpriced.length > 0)
    lines.push(
      "Calls without a price (declare cost_per_mtok):",
      ...r.unpriced.map((u) => `  ${u.model}: ${String(u.calls)} call(s)`),
    );
  const t = r.ticket;
  if (t) {
    lines.push(`Ticket ${t.key}, current version ${t.version.slice(0, 12)}:`);
    lines.push(
      "Versions:",
      ...t.versions.map(
        (v) => `  ${v.key.slice(0, 12)} since ${v.first}: ${cost(v)}, ${String(v.tokens)} tokens`,
      ),
    );
    for (const [title, groups] of [
      ["Cases", t.cases],
      ["Shared work (ticket)", t.shared],
      ["By role", t.byRole],
      ["By model", t.byModel],
      ["By stage", t.byStage],
    ] as const)
      if (groups.length > 0) lines.push(`${title}:`, ...groups.map(groupLine));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The month's line and the tickets at 80% or more of a ticket limit, for `qj status` (REQ-FLOW-06/AC9).
 *
 * @param entries - The ledger.
 * @param budget - The project's budgets.
 * @param now - The current time.
 * @returns The lines; empty without ticket and month limits.
 */
export function budgetStatusLines(
  entries: readonly SpendEntry[],
  budget: ProjectConfig["budget"],
  now: Date,
): string[] {
  if (budget.month === undefined && budget.ticket === undefined) return [];
  const period = monthOf(now, budget.time_zone);
  const report = budgetReport(entries, budget, { period });
  const month =
    report.limits.length > 0
      ? report.limits
          .map(
            (l) =>
              `${l.metric} ${l.atLeast ? "at least " : ""}${value(l.metric, l.spent)} of ${value(l.metric, l.limit)} (${l.atLeast ? "≥ " : ""}${String(l.percent)}%)`,
          )
          .join(", ")
      : `${cost(report.month)}, ${String(report.month.tokens)} tokens`;
  const lines = [`Budget ${period}: ${month}`];
  if (budget.ticket !== undefined) {
    // One pass groups the ledger by ticket; each ticket's limits are then computed from its own entries.
    const byTicket = new Map<string, SpendEntry[]>();
    for (const e of entries) {
      const own = byTicket.get(e.ticket);
      if (own) own.push(e);
      else byTicket.set(e.ticket, [e]);
    }
    const near = [...byTicket].flatMap(([ticket, own]) => {
      const top = budgetReport(own, budget, { period, ticket })
        .limits.filter((l) => l.scope === "ticket" && l.percent >= 80)
        .sort((a, b) => b.percent - a.percent)[0];
      return top ? [`${ticket} (${String(top.percent)}% ${top.metric})`] : [];
    });
    if (near.length > 0) lines.push(`Tickets at 80% or more of their budget: ${near.join(", ")}`);
  }
  return lines;
}

/**
 * `qajitsu budget`: spend against the ticket and month limits (REQ-FLOW-06/AC9); `--rebuild` regenerates the ledger
 * from the run journals (AC2).
 */
export async function runBudget(
  options: {
    readonly month?: string | undefined;
    readonly ticket?: string | undefined;
    readonly json?: boolean | undefined;
    readonly rebuild?: boolean | undefined;
  },
  io: CommandIO,
  ports: RuntimePorts,
): Promise<number> {
  try {
    const project = await loadProject(io.cwd, ports.project);
    const root = rootOf(project, ports);
    if (options.rebuild === true) {
      const done = await rebuildLedger(project, root);
      io.write(
        `Spend ledger rebuilt from ${String(done.runs)} run journal(s): ${String(done.entries)} entries${done.dropped > 0 ? `, ${String(done.dropped)} invalid line(s) dropped` : ""}.\n`,
      );
      return 0;
    }
    if (options.month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(options.month))
      throw new ConfigError(
        "BUDGET_MONTH_INVALID",
        `--month needs YYYY-MM, not '${options.month.slice(0, 20)}'.`,
        {},
      );
    if (options.ticket !== undefined && !TicketKeySchema.safeParse(options.ticket).success)
      throw new ConfigError("TICKET_KEY_INVALID", `Invalid ticket key '${options.ticket.slice(0, 40)}'.`, {});
    const { budget } = project.config;
    const entries = await fileSpendLedger(join(root, SPEND_LEDGER_FILE)).read();
    const problems = await ledgerProblems(project, root);
    const report = budgetReport(entries, budget, {
      period: options.month ?? monthOf(ports.now(), budget.time_zone),
      ticket: options.ticket,
    });
    if (options.json === true)
      io.write(`${JSON.stringify({ ...report, ledgerProblems: problems }, null, 2)}\n`);
    else io.write(formatBudgetReport(report));
    if (problems.length > 0) {
      io.writeError(
        `The spend ledger does not match the run journals; new runs are refused until qajitsu budget --rebuild:\n${problems
          .slice(0, 5)
          .map((p) => `  ${p}\n`)
          .join("")}`,
      );
      return 2;
    }
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
}
