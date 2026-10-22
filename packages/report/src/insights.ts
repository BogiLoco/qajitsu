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
  /** Where the run's active time went (REQ-NFR-11/AC2). */
  readonly timing: RunTiming;
  /** QAJitsu version that ran it, from the recorded versions. */
  readonly qajitsuVersion?: string;
}

/**
 * The active time of a run, in milliseconds (REQ-NFR-11/AC2): the time its stages were running (idle time between
 * commands, e.g. waiting for an approval, is not counted), split into model calls, starting the environment, test
 * execution and everything else (QAJitsu's own processing). Overlapping work (lanes, parallel calls) is counted once.
 */
export interface RunTiming {
  readonly activeMs: number;
  readonly modelMs: number;
  readonly environmentMs: number;
  readonly testsMs: number;
  readonly otherMs: number;
  /** Duration of every span of each stage, e.g. two `plan` spans after a revision. */
  readonly stages: Readonly<Record<string, readonly number[]>>;
}

type Interval = readonly [number, number];

/** Total length of a set of intervals, overlaps counted once. */
export function unionMs(intervals: readonly Interval[]): number {
  const sorted = [...intervals].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of sorted) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

/** Intervals of `inner` clipped to `outer`, so a category never counts time outside the active stages. */
const clip = (inner: readonly Interval[], outer: readonly Interval[]): Interval[] =>
  inner.flatMap(([a, b]) =>
    outer.flatMap(([c, d]): Interval[] =>
      Math.min(b, d) > Math.max(a, c) ? [[Math.max(a, c), Math.min(b, d)]] : [],
    ),
  );

/**
 * Times of a run from its journal (REQ-NFR-11/AC1+AC2): stage spans from their first event to `stage.end`, model
 * calls from their recorded duration, the environment from the start of the run stage to its health check when the
 * run built or started one, test execution from case attempts.
 *
 * @param events - The run's journal.
 */
export function runTiming(events: readonly RunEvent[]): RunTiming {
  const open = new Map<string, number>();
  const spans: { stage: string; interval: Interval }[] = [];
  const model: Interval[] = [];
  const environment: Interval[] = [];
  const attempts = new Map<string, number>();
  const tests: Interval[] = [];
  let runStart: number | undefined;
  let built = false;
  const last = new Map<string, number>();
  const close = (stage: string): void => {
    const started = open.get(stage);
    if (started !== undefined) spans.push({ stage, interval: [started, last.get(stage) ?? started] });
    open.delete(stage);
  };
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) continue;
    const d = (e.details ?? {}) as Record<string, unknown>;
    if (!BOOKKEEPING.has(e.stage)) {
      // A stage starts at stage.start or its first event, and ends at stage.end or its last event.
      if (e.event === "stage.start") close(e.stage);
      if (!open.has(e.stage)) open.set(e.stage, t);
      last.set(e.stage, t);
      if (e.event === "stage.end") close(e.stage);
    }
    if (e.event === "model.usage" && typeof d["durationMs"] === "number")
      model.push([t - d["durationMs"], t]);
    if (e.stage === "run" && e.event === "stage.start") runStart = t;
    if (e.event === "env.build" || e.event === "env.selected") built = true;
    if (e.event === "env.health" && runStart !== undefined && built) environment.push([runStart, t]);
    const part = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v) : "");
    const key = [d["caseId"], d["attempt"], d["lane"], d["variant"]].map(part).join(":");
    if (e.event === "case.attempt.start") attempts.set(key, t);
    if (e.event === "case.attempt.end") {
      const started = attempts.get(key);
      if (started !== undefined) tests.push([started, t]);
      attempts.delete(key);
    }
  }
  for (const stage of [...open.keys()]) close(stage);
  const active = spans.map((s) => s.interval);
  const modelIn = clip(model, active);
  const envIn = clip(environment, active);
  const testsIn = clip(tests, active);
  const activeMs = unionMs(active);
  const stages: Record<string, number[]> = {};
  for (const s of spans) stages[s.stage] = [...(stages[s.stage] ?? []), s.interval[1] - s.interval[0]];
  return {
    activeMs,
    modelMs: unionMs(modelIn),
    environmentMs: unionMs(envIn),
    testsMs: unionMs(testsIn),
    otherMs: Math.max(0, activeMs - unionMs([...modelIn, ...envIn, ...testsIn])),
    stages,
  };
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
const BOOKKEEPING = new Set(["certificate", "publish", "promote", "ci", "audit-trail", "timing"]);

/** Default time budgets per stage in seconds (REQ-NFR-11/AC3); a project overrides them in `timing.budgets_s`. */
export const DEFAULT_STAGE_BUDGETS_S: Readonly<Record<string, number>> = {
  fetch: 300,
  analyze: 900,
  plan: 1200,
  run: 3600,
  audit: 900,
  triage: 600,
  explore: 3600,
};

/** A stage that took longer than its budget. */
export interface StageOverBudget {
  readonly stage: string;
  readonly ms: number;
  readonly budgetS: number;
}

/**
 * The stages whose latest span took longer than their budget (REQ-NFR-11/AC3). Budgets only warn: nothing here can
 * change a status.
 *
 * @param timing - The run's timing.
 * @param stages - Stages to look at, normally those of the command that just ran.
 * @param budgets - Project budgets in seconds, over the defaults.
 */
export function stagesOverBudget(
  timing: RunTiming,
  stages: readonly string[],
  budgets: Readonly<Record<string, number>>,
): StageOverBudget[] {
  const all = { ...DEFAULT_STAGE_BUDGETS_S, ...budgets };
  return stages.flatMap((stage) => {
    const ms = timing.stages[stage]?.at(-1);
    const budgetS = all[stage];
    return ms !== undefined && budgetS !== undefined && ms > budgetS * 1000 ? [{ stage, ms, budgetS }] : [];
  });
}

/** `1m 05s`, `42s`, `1h 02m`. */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  if (s < 3600) return `${String(Math.floor(s / 60))}m ${String(s % 60).padStart(2, "0")}s`;
  return `${String(Math.floor(s / 3600))}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

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
  const versions = input.data["versions"] as Record<string, unknown> | undefined;
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
    timing: runTiming(input.events),
    ...(typeof versions?.["qajitsu"] === "string" ? { qajitsuVersion: versions["qajitsu"] } : {}),
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

const median = (values: readonly number[]): number => {
  const v = [...values].sort((a, b) => a - b);
  if (v.length === 0) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? (v[mid] ?? 0) : ((v[mid - 1] ?? 0) + (v[mid] ?? 0)) / 2;
};

/** Medians of stage durations over a set of runs, in milliseconds. */
const stageMedians = (digests: readonly RunDigest[]): Record<string, number> => {
  const all: Record<string, number[]> = {};
  for (const d of digests)
    for (const [stage, spans] of Object.entries(d.timing.stages))
      all[stage] = [...(all[stage] ?? []), spans.reduce((a, b) => a + b, 0)];
  return Object.fromEntries(Object.entries(all).map(([stage, v]) => [stage, median(v)]));
};

/** Where the time of a project's runs goes (REQ-NFR-11/AC2+AC4), as medians per run, in milliseconds. */
export interface TimeInsights {
  readonly runs: number;
  readonly perRun: {
    readonly activeMs: number;
    readonly modelMs: number;
    readonly environmentMs: number;
    readonly testsMs: number;
    readonly otherMs: number;
  };
  /** Median total time of each stage in a run. */
  readonly stages: Readonly<Record<string, number>>;
  /** Stage medians by QAJitsu version and by ISO week, for trends. */
  readonly byVersion: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly byWeek: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/**
 * Time insights of a set of runs (REQ-NFR-11/AC2+AC4): medians per run and per stage, and the same per QAJitsu
 * version and per week, so a slower release or a slower project shows up.
 *
 * @param digests - Run digests; runs that did nothing (no active time) are left out.
 */
export function timeInsights(digests: readonly RunDigest[]): TimeInsights {
  const runs = digests.filter((d) => d.timing.activeMs > 0);
  const group = (key: (d: RunDigest) => string | undefined): Record<string, Record<string, number>> => {
    const groups = new Map<string, RunDigest[]>();
    for (const d of runs) {
      const k = key(d);
      if (k !== undefined) groups.set(k, [...(groups.get(k) ?? []), d]);
    }
    return Object.fromEntries([...groups.entries()].sort().map(([k, v]) => [k, stageMedians(v)]));
  };
  return {
    runs: runs.length,
    perRun: {
      activeMs: median(runs.map((d) => d.timing.activeMs)),
      modelMs: median(runs.map((d) => d.timing.modelMs)),
      environmentMs: median(runs.map((d) => d.timing.environmentMs)),
      testsMs: median(runs.map((d) => d.timing.testsMs)),
      otherMs: median(runs.map((d) => d.timing.otherMs)),
    },
    stages: stageMedians(runs),
    byVersion: group((d) => d.qajitsuVersion),
    byWeek: group((d) => isoWeek(d.day)),
  };
}
