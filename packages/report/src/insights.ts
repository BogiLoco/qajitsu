import { contextUsage, type ContextUsage } from "./context-metrics.js";
import type { RunEvent } from "@qajitsu/core";

/** What one model role did in a run. */
export interface RoleDigest {
  /** The model of the role's last call. */
  readonly model: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  /** False once a call of the role had no known price. */
  readonly costKnown: boolean;
  /** Durations of the calls in milliseconds, for latency percentiles. */
  readonly durationsMs: readonly number[];
  /** Agent steps of the role (a stage, a case of the author) and how many needed a repair of invalid output. */
  readonly steps: number;
  readonly repairedSteps: number;
  readonly repairs: number;
  /** Tool calls the guard denied. */
  readonly guardDenials: number;
}

/** Outcomes of the roles computed by code (REQ-LLM-14/AC2). */
export interface OutcomeDigest {
  readonly author: {
    readonly cases: number;
    readonly firstTry: number;
    readonly failed: number;
    readonly findings: Readonly<Record<string, number>>;
    readonly rules: Readonly<Record<string, number>>;
  };
  readonly review: { readonly accepted: number; readonly sentBack: number };
  /** The planner's last plan version: what code flagged in it and what of the ticket and change it left uncovered. */
  readonly planner: { readonly versions: number; readonly flags: number; readonly gaps: number };
  readonly healer: { readonly heals: number; readonly accepted: number };
}

/** What a run says about the quality of its plan and tests (REQ-PLAN-16). */
export interface QualityDigest {
  /** Version of the approved plan; 1 means approved without changes. */
  readonly approvedVersion?: number;
  /** Result of the readiness gate (REQ-PLAN-13), when it ran. */
  readonly readiness?: string;
  readonly failedCases: number;
  /** FAILED cases a person found to be a test, environment or data problem (`qj feedback`). */
  readonly falseFailed: number;
  readonly auditorDowngrades: number;
  /** Defects found later on the ticket and linked to this run (`qj feedback --escaped`). */
  readonly escaped: number;
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
  readonly outcomes: OutcomeDigest;
  readonly quality: QualityDigest;
  /** QAJitsu version that ran it, from the recorded versions. */
  readonly qajitsuVersion?: string;
  /** How each role on each model used its context (REQ-CTX-18/AC1). */
  readonly context?: readonly ContextUsage[];
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
const BOOKKEEPING = new Set(["certificate", "publish", "promote", "ci", "audit-trail", "timing", "feedback"]);

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
  const role = (name: string): RoleDigest =>
    roles[name] ?? {
      model: "",
      calls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      costKnown: true,
      durationsMs: [],
      steps: 0,
      repairedSteps: 0,
      repairs: 0,
      guardDenials: 0,
    };
  /** One agent step of a role: an attempts count above 1 means invalid output was sent back. */
  const step = (name: string, attempts: unknown): void => {
    const a = typeof attempts === "number" && attempts > 0 ? attempts : 1;
    const r = role(name);
    roles[name] = {
      ...r,
      steps: r.steps + 1,
      repairedSteps: r.repairedSteps + (a > 1 ? 1 : 0),
      repairs: r.repairs + a - 1,
    };
  };
  const author = {
    cases: 0,
    firstTry: 0,
    failed: 0,
    findings: {} as Record<string, number>,
    rules: {} as Record<string, number>,
  };
  const review = { accepted: 0, sentBack: 0 };
  const planner = { versions: 0, flags: 0, gaps: 0 };
  const healer = { heals: 0, accepted: 0 };
  let readiness: string | undefined;
  let auditorDowngrades = 0;
  const add = (into: Record<string, number>, from: unknown): void => {
    if (from === null || typeof from !== "object") return;
    for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + num(v);
  };
  for (const e of input.events) {
    if (!BOOKKEEPING.has(e.stage)) stages.add(e.stage);
    const d = (e.details ?? {}) as Record<string, unknown>;
    if (e.event === "model.usage") {
      withModel.add(e.stage);
      const name = typeof d["role"] === "string" ? d["role"] : "unknown";
      const priced = typeof d["costUsd"] === "number";
      const before = role(name);
      roles[name] = {
        ...before,
        model: typeof d["model"] === "string" ? d["model"] : before.model,
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
    // Agent steps and their repairs (REQ-LLM-14/AC1), by the stage that ran them.
    const stepRole = STEP_ROLES[`${e.stage}:${e.event}`];
    if (stepRole !== undefined && "attempts" in d) step(stepRole, d["attempts"]);
    if (e.event === "tool_denied" && e.actor.kind === "agent") {
      const r = role(e.actor.name);
      roles[e.actor.name] = { ...r, guardDenials: r.guardDenials + 1 };
    }
    if (e.stage === "author" && e.event === "case.end") {
      author.cases += 1;
      if (d["ok"] === true && num(d["attempts"]) <= 1) author.firstTry += 1;
      if (d["ok"] !== true) author.failed += 1;
      add(author.findings, d["findings"]);
      add(author.rules, d["rules"]);
    }
    if (e.event === "spec.review" && d["decision"] === "accept") review.accepted += 1;
    if (e.event === "spec.review" && d["decision"] === "send_back") review.sentBack += 1;
    if (e.event === "plan.coverage") {
      planner.versions += 1;
      planner.flags = num(d["flags"]);
      planner.gaps = num(d["gaps"]);
    }
    if (e.event === "heal.end") {
      healer.heals += 1;
      if (d["ok"] === true) healer.accepted += 1;
    }
    if (e.event === "readiness.result" && typeof d["result"] === "string") readiness = d["result"];
    if (e.event === "audit.done") auditorDowngrades += num(d["weak"]);
  }
  const decision = input.data["decision"];
  const versions = input.data["versions"] as Record<string, unknown> | undefined;
  const results = (input.data["results"] ?? {}) as Record<string, unknown>;
  const feedback = (input.data["feedback"] ?? {}) as {
    cases?: Record<string, { is?: unknown }>;
    escaped?: unknown[];
  };
  const approval = input.data["approval"] as { version?: unknown } | undefined;
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
    context: contextUsage(input.events),
    outcomes: { author, review, planner, healer },
    quality: {
      ...(typeof approval?.version === "number" ? { approvedVersion: approval.version } : {}),
      ...(readiness === undefined ? {} : { readiness }),
      failedCases: Object.values(results).filter((s) => s === "FAILED").length,
      falseFailed: Object.entries(feedback.cases ?? {}).filter(
        ([caseId, f]) => results[caseId] === "FAILED" && f.is !== "product-bug",
      ).length,
      auditorDowngrades,
      escaped: (feedback.escaped ?? []).length,
    },
    ...(typeof versions?.["qajitsu"] === "string" ? { qajitsuVersion: versions["qajitsu"] } : {}),
  };
}

/** Which role ran the agent step that ends with this stage and event (its details carry `attempts`). */
const STEP_ROLES: Readonly<Record<string, string>> = {
  "analyze:stage.end": "analyst",
  "plan:stage.end": "planner",
  "triage:stage.end": "triage",
  "triage:blocked.end": "triage",
  "author:case.end": "author",
  "explore:stage.end": "explorer",
};

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

/** Plan and test quality of a project (REQ-PLAN-16): every number from run records and recorded feedback. */
export interface PlanInsights {
  readonly approvedPlans: number;
  /** Share of approved plans whose first version was approved (0..1). */
  readonly approvedUnchangedShare: number;
  readonly averageRevisionRounds: number;
  /** Tickets checked by the readiness gate, and the share it stopped (not READY). */
  readonly readinessChecked: number;
  readonly readinessStoppedShare: number;
  readonly failedCases: number;
  /** FAILED cases a person found to be no product bug, and their share of the FAILED cases. */
  readonly falseFailed: number;
  readonly falseFailedShare: number;
  readonly auditorDowngrades: number;
  readonly escapedDefects: number;
}

/**
 * Plan and test quality over a set of runs (REQ-PLAN-16/AC1+AC2+AC4).
 *
 * @param digests - The project's runs.
 */
export function planInsights(digests: readonly RunDigest[]): PlanInsights {
  const approved = digests.filter((d) => d.quality.approvedVersion !== undefined);
  const unchanged = approved.filter((d) => d.quality.approvedVersion === 1).length;
  const rounds = approved.reduce((a, d) => a + (d.quality.approvedVersion ?? 1) - 1, 0);
  const checked = new Map<string, string>();
  for (const d of digests) if (d.quality.readiness !== undefined) checked.set(d.ticket, d.quality.readiness);
  const stopped = [...checked.values()].filter((r) => r !== "READY").length;
  const failed = digests.reduce((a, d) => a + d.quality.failedCases, 0);
  const falseFailed = digests.reduce((a, d) => a + d.quality.falseFailed, 0);
  return {
    approvedPlans: approved.length,
    approvedUnchangedShare: approved.length === 0 ? 0 : round(unchanged / approved.length),
    averageRevisionRounds: approved.length === 0 ? 0 : round(rounds / approved.length),
    readinessChecked: checked.size,
    readinessStoppedShare: checked.size === 0 ? 0 : round(stopped / checked.size),
    failedCases: failed,
    falseFailed,
    falseFailedShare: failed === 0 ? 0 : round(falseFailed / failed),
    auditorDowngrades: digests.reduce((a, d) => a + d.quality.auditorDowngrades, 0),
    escapedDefects: digests.reduce((a, d) => a + d.quality.escaped, 0),
  };
}

/** The scorecard of one agent role on one model (REQ-LLM-14/AC1). */
export interface RoleScore {
  readonly role: string;
  readonly model: string;
  readonly runs: number;
  readonly calls: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly costKnown: boolean;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly steps: number;
  /** Share of the role's steps that needed no repair of invalid output (0..1). */
  readonly noRepairShare: number;
  readonly repairs: number;
  readonly guardDenials: number;
}

/** The agent scorecard of a set of runs (REQ-LLM-14/AC1+AC2). */
export interface AgentScorecard {
  readonly roles: readonly RoleScore[];
  readonly author: {
    readonly cases: number;
    /** Share of cases whose first answer passed every check and the quality gate (0..1). */
    readonly firstTryShare: number;
    readonly failed: number;
    readonly findings: Readonly<Record<string, number>>;
    readonly rules: Readonly<Record<string, number>>;
    readonly reviewAccepted: number;
    readonly reviewSentBack: number;
  };
  readonly planner: {
    readonly plans: number;
    /** Average flagged expectations and coverage gaps in the last version of a plan. */
    readonly averageFlags: number;
    readonly averageGaps: number;
  };
  readonly healer: { readonly heals: number; readonly acceptedShare: number };
}

const percentile = (values: readonly number[], p: number): number => {
  const v = [...values].sort((a, b) => a - b);
  if (v.length === 0) return 0;
  return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)] ?? 0;
};

/**
 * The agent scorecard (REQ-LLM-14/AC1+AC2): per role and model the calls, tokens, cost, latency, repairs and guard
 * denials, and the outcomes code measured: the author's first-try share and what the checks rejected, review
 * decisions, the planner's flags and coverage gaps, the healer's accepted heals. Never a model's opinion.
 *
 * @param digests - Runs of a project or a benchmark.
 */
export function agentScorecard(digests: readonly RunDigest[]): AgentScorecard {
  const byRole = new Map<
    string,
    { score: Omit<RoleScore, "p50Ms" | "p95Ms" | "noRepairShare">; durations: number[]; repaired: number }
  >();
  for (const d of digests)
    for (const [role, r] of Object.entries(d.roles)) {
      const key = `${role} ${r.model}`;
      const b = byRole.get(key) ?? {
        score: {
          role,
          model: r.model,
          runs: 0,
          calls: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          costKnown: true,
          steps: 0,
          repairs: 0,
          guardDenials: 0,
        },
        durations: [],
        repaired: 0,
      };
      byRole.set(key, {
        score: {
          ...b.score,
          runs: b.score.runs + 1,
          calls: b.score.calls + r.calls,
          inputTokens: b.score.inputTokens + r.inputTokens,
          cachedInputTokens: b.score.cachedInputTokens + r.cachedInputTokens,
          outputTokens: b.score.outputTokens + r.outputTokens,
          costUsd: b.score.costUsd + r.costUsd,
          costKnown: b.score.costKnown && r.costKnown,
          steps: b.score.steps + r.steps,
          repairs: b.score.repairs + r.repairs,
          guardDenials: b.score.guardDenials + r.guardDenials,
        },
        durations: [...b.durations, ...r.durationsMs],
        repaired: b.repaired + r.repairedSteps,
      });
    }
  const sum = (f: (d: RunDigest) => number): number => digests.reduce((a, d) => a + f(d), 0);
  const merge = (f: (d: RunDigest) => Readonly<Record<string, number>>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const d of digests) for (const [k, v] of Object.entries(f(d))) out[k] = (out[k] ?? 0) + v;
    return out;
  };
  const cases = sum((d) => d.outcomes.author.cases);
  const planned = digests.filter((d) => d.outcomes.planner.versions > 0);
  const heals = sum((d) => d.outcomes.healer.heals);
  return {
    roles: [...byRole.values()]
      .map(({ score, durations, repaired }) => ({
        ...score,
        costUsd: round(score.costUsd),
        p50Ms: percentile(durations, 50),
        p95Ms: percentile(durations, 95),
        noRepairShare: score.steps === 0 ? 1 : round((score.steps - repaired) / score.steps),
      }))
      .sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : a.model < b.model ? -1 : 1)),
    author: {
      cases,
      firstTryShare: cases === 0 ? 0 : round(sum((d) => d.outcomes.author.firstTry) / cases),
      failed: sum((d) => d.outcomes.author.failed),
      findings: merge((d) => d.outcomes.author.findings),
      rules: merge((d) => d.outcomes.author.rules),
      reviewAccepted: sum((d) => d.outcomes.review.accepted),
      reviewSentBack: sum((d) => d.outcomes.review.sentBack),
    },
    planner: {
      plans: planned.length,
      averageFlags:
        planned.length === 0
          ? 0
          : round(planned.reduce((a, d) => a + d.outcomes.planner.flags, 0) / planned.length),
      averageGaps:
        planned.length === 0
          ? 0
          : round(planned.reduce((a, d) => a + d.outcomes.planner.gaps, 0) / planned.length),
    },
    healer: { heals, acceptedShare: heals === 0 ? 0 : round(sum((d) => d.outcomes.healer.accepted) / heals) },
  };
}
