import type { RunEvent } from "@qajitsu/core";

/** What one model role did in a run. */
export interface RoleDigest {
  readonly calls: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  /** False once a call of the role had no known price. */
  readonly costKnown: boolean;
  /** Durations of the calls in milliseconds, for latency percentiles. */
  readonly durationsMs: readonly number[];
}

/** The numbers of one run, computed from its record, journal and results (REQ-LLM-11, invariant 6). */
export interface RunDigest {
  readonly ticket: string;
  readonly runId: string;
  /** Day the run was created, `YYYY-MM-DD`. */
  readonly day: string;
  readonly executed: boolean;
  /** A GO or NO-GO decision was computed: the ticket was verified (REQ-SCALE-10/AC1). */
  readonly verified: boolean;
  readonly costUsd: number;
  readonly costKnown: boolean;
  readonly roles: Readonly<Record<string, RoleDigest>>;
  /** Execution time of every attempt of every case. */
  readonly runnerMs: number;
  /** Pipeline stages of the run, and those that called a model. */
  readonly stages: readonly string[];
  readonly stagesWithModel: readonly string[];
}

/** Inputs of {@link digestRun}, read by the caller. */
export interface RunDigestInput {
  readonly ticket: string;
  readonly runId: string;
  readonly createdAt: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly events: readonly RunEvent[];
  /** Duration of every attempt of every case result, in milliseconds. */
  readonly attemptsMs: readonly number[];
}

/** Stages that do bookkeeping after the verdict; they say nothing about how the work was done. */
const BOOKKEEPING = new Set(["certificate", "publish", "promote", "ci", "audit-trail"]);

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * The numbers of one run (REQ-LLM-11/AC2): its cost, per role the calls, tokens (cached input included), cost and
 * call durations, its runner time, and which pipeline stages called a model. Every number comes from the run's own
 * records; a model call without a known price makes the run's cost unknown, never 0.
 *
 * @param input - The run's record, journal events and attempt durations.
 */
export function digestRun(input: RunDigestInput): RunDigest {
  const roles: Record<string, RoleDigest> = {};
  const stages = new Set<string>();
  const withModel = new Set<string>();
  let costUsd = 0;
  let costKnown = true;
  for (const e of input.events) {
    if (!BOOKKEEPING.has(e.stage)) stages.add(e.stage);
    if (e.event !== "model.usage") continue;
    withModel.add(e.stage);
    const d = (e.details ?? {}) as Record<string, unknown>;
    const role = typeof d["role"] === "string" ? d["role"] : "unknown";
    const priced = typeof d["costUsd"] === "number";
    const before = roles[role] ?? {
      calls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      costKnown: true,
      durationsMs: [],
    };
    roles[role] = {
      calls: before.calls + 1,
      inputTokens: before.inputTokens + num(d["inputTokens"]),
      cachedInputTokens: before.cachedInputTokens + num(d["cachedInputTokens"]),
      outputTokens: before.outputTokens + num(d["outputTokens"]),
      costUsd: before.costUsd + num(d["costUsd"]),
      costKnown: before.costKnown && priced,
      durationsMs:
        typeof d["durationMs"] === "number" ? [...before.durationsMs, d["durationMs"]] : before.durationsMs,
    };
    costUsd += num(d["costUsd"]);
    if (!priced) costKnown = false;
  }
  const decision = input.data["decision"];
  return {
    ticket: input.ticket,
    runId: input.runId,
    day: input.createdAt.slice(0, 10),
    executed: input.data["results"] !== undefined,
    verified: decision === "GO" || decision === "NO-GO",
    costUsd,
    costKnown,
    roles,
    runnerMs: input.attemptsMs.reduce((a, b) => a + b, 0),
    stages: [...stages],
    stagesWithModel: [...withModel],
  };
}

/** ISO week of a day, `YYYY-Www`: the week of its Thursday, counted from the year's first Thursday. */
export function isoWeek(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const year = d.getUTCFullYear();
  const week = 1 + Math.floor((d.getTime() - Date.UTC(year, 0, 1)) / (7 * 86_400_000));
  return `${String(year)}-W${String(week).padStart(2, "0")}`;
}

/** Costs of a set of runs, for a project or a week (REQ-LLM-11/AC2). */
export interface CostInsights {
  readonly runs: number;
  readonly tickets: number;
  /** Tickets with at least one run that reached a GO or NO-GO decision. */
  readonly verifiedTickets: number;
  readonly costUsd: number;
  /** False when some model call had no known price: the cost is a lower bound, never shown as exact. */
  readonly costKnown: boolean;
  /** Every run's cost (verified or not) over the verified tickets; missing when none was verified. */
  readonly costPerVerifiedTicketUsd?: number;
  readonly byRole: Readonly<Record<string, { readonly calls: number; readonly costUsd: number }>>;
  readonly runnerMinutesPerTicket: number;
  /** Share of pipeline stages that called no model (0..1). */
  readonly stagesWithoutModelShare: number;
}

/**
 * Aggregates run digests (REQ-LLM-11/AC2): cost per verified ticket counts the cost of every run, also those that
 * decided nothing, because they were paid for too.
 *
 * @param digests - Runs of a project, a week or any other set.
 */
export function costInsights(digests: readonly RunDigest[]): CostInsights {
  const tickets = new Set(digests.map((d) => d.ticket));
  const verified = new Set(digests.filter((d) => d.verified).map((d) => d.ticket));
  const costUsd = digests.reduce((a, d) => a + d.costUsd, 0);
  const byRole: Record<string, { calls: number; costUsd: number }> = {};
  for (const d of digests)
    for (const [role, r] of Object.entries(d.roles)) {
      const b = byRole[role] ?? { calls: 0, costUsd: 0 };
      byRole[role] = { calls: b.calls + r.calls, costUsd: b.costUsd + r.costUsd };
    }
  const stages = digests.reduce((a, d) => a + d.stages.length, 0);
  const withModel = digests.reduce(
    (a, d) => a + d.stagesWithModel.filter((s) => d.stages.includes(s)).length,
    0,
  );
  const runnerMs = digests.reduce((a, d) => a + d.runnerMs, 0);
  return {
    runs: digests.length,
    tickets: tickets.size,
    verifiedTickets: verified.size,
    costUsd: round(costUsd),
    costKnown: digests.every((d) => d.costKnown),
    ...(verified.size > 0 ? { costPerVerifiedTicketUsd: round(costUsd / verified.size) } : {}),
    byRole: Object.fromEntries(
      Object.entries(byRole).map(([k, v]) => [k, { calls: v.calls, costUsd: round(v.costUsd) }]),
    ),
    runnerMinutesPerTicket: tickets.size === 0 ? 0 : round(runnerMs / 60_000 / tickets.size),
    stagesWithoutModelShare: stages === 0 ? 0 : round((stages - withModel) / stages),
  };
}

/** Cost insights per ISO week, oldest first (REQ-LLM-11/AC4). */
export function weeklyCosts(digests: readonly RunDigest[]): { week: string; insights: CostInsights }[] {
  const weeks = new Map<string, RunDigest[]>();
  for (const d of digests) {
    const w = isoWeek(d.day);
    weeks.set(w, [...(weeks.get(w) ?? []), d]);
  }
  return [...weeks.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([week, runs]) => ({ week, insights: costInsights(runs) }));
}

const round = (n: number): number => Number(n.toFixed(6));
