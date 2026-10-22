import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  ConfigError,
  QajitsuError,
  RunRecordSchema,
  readKnowledgeIndex,
  TicketKeySchema,
  openRunWorkspace,
  parseEventLines,
  readRunIndex,
  resolveWorkspaceRoot,
} from "@qajitsu/core";
import { agentScorecard, digestRun, type AgentScorecard, type RunDigest } from "@qajitsu/report";
import { parse } from "yaml";
import { z } from "zod";
import type { RuntimePorts } from "../adapters.js";
import { loadProject } from "../project.js";
import type { ModelPorts } from "../session.js";
import { runFetch, type CommandIO } from "./fetch.js";
import { runApprove, runPlan, type ReviewPorts } from "./plan.js";
import { runRun, type RunPorts } from "./run.js";

/** `.qa/bench.yaml`: seeded-bug cases for `qajitsu bench` (REQ-LLM-06). */
export const BenchCasesSchema = z.strictObject({
  version: z.literal(1),
  cases: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9-]+$/),
        ticket: TicketKeySchema,
        /** Bug flags switched on through `--set <base service>.<FLAG>=1`. */
        flags: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
        /** `--ref` for fetch when the ticket has no change of its own, e.g. `shop=main`. */
        ref: z.string().optional(),
        expect: z.union([
          z.strictObject({
            detects: z.string().min(1),
            /** The ticket's acceptance criterion the bug breaks: the plan must have a case for it (REQ-LLM-14/AC4). */
            criterion: z
              .string()
              .regex(/^AC\d+$/)
              .optional(),
          }),
          z.strictObject({ all_passed: z.literal(true) }),
        ]),
      }),
    )
    .min(1),
});

/** One benchmark case result. */
export interface BenchCaseResult {
  readonly id: string;
  readonly ticket: string;
  readonly flags: readonly string[];
  readonly expect: "detect" | "all_passed";
  readonly planAccepted: boolean;
  readonly statuses: Readonly<Record<string, string>>;
  /** A seeded bug ended FAILED in at least one case. */
  readonly detected?: boolean;
  /** FAILED cases with every bug flag off. */
  readonly falseFailed: number;
  readonly blocked: number;
  readonly durationMs: number;
  readonly tokens: number;
  readonly costUsd?: number | undefined;
  readonly error?: string;
  /** Whether the analyst and planner had the project's knowledge base (REQ-KNOW-11). */
  readonly knowledge?: boolean;
  /** The approved plan has a case whose source is the bug's acceptance criterion (REQ-LLM-14/AC4). */
  readonly criterionCovered?: boolean;
}

type Rate = "detectionRate" | "falseFailedRate" | "blockedRate" | "planAcceptanceRate";

/** Rates and totals of a set of benchmark cases. */
export interface BenchSummary {
  readonly detectionRate: number;
  readonly falseFailedRate: number;
  readonly blockedRate: number;
  readonly planAcceptanceRate: number;
  readonly durationMs: number;
  readonly tokens: number;
  readonly costUsd?: number | undefined;
  /** Share of bug cases whose approved plan covers the bug's criterion, when the cases name one. */
  readonly criterionCoverageRate?: number | undefined;
}

/** Benchmark report written to `<out>/<date>-<model>.json`. */
export interface BenchReport {
  readonly model: string;
  readonly role: string;
  readonly at: string;
  /** `on`: with the knowledge base (if the project has one), `off`: without, `compare`: both (REQ-KNOW-11). */
  readonly knowledge?: "on" | "off" | "compare";
  readonly cases: readonly BenchCaseResult[];
  readonly summary: BenchSummary;
  /** The agent scorecard of the benchmark's runs (REQ-LLM-14/AC4). */
  readonly scorecard?: AgentScorecard;
  /** Changes since the previous report of the same model and role, when there is one. */
  readonly sincePrevious?: BenchChanges;
  /** With `compare`: each case without and with the knowledge base, and the difference (with − without). */
  readonly comparison?: {
    readonly without: BenchSummary;
    readonly with: BenchSummary;
    readonly delta: Pick<BenchSummary, Rate>;
  };
}

/** What changed since the previous benchmark of the same model (REQ-LLM-14/AC4): later minus earlier. */
export interface BenchChanges {
  readonly previousAt: string;
  readonly detectionRate: number;
  readonly falseFailedRate: number;
  readonly blockedRate: number;
  readonly planAcceptanceRate: number;
  readonly criterionCoverageRate?: number;
  readonly authorFirstTryShare?: number;
  readonly plannerAverageFlags?: number;
  readonly plannerAverageGaps?: number;
}

/**
 * The changes between two benchmark reports of the same model (REQ-LLM-14/AC4).
 *
 * @param previous - The earlier report.
 * @param current - The new one.
 */
export function benchChanges(previous: BenchReport, current: BenchReport): BenchChanges {
  const d = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined || b === undefined ? undefined : Number((b - a).toFixed(3));
  const optional = (k: string, v: number | undefined): Record<string, number> =>
    v === undefined ? {} : { [k]: v };
  return {
    previousAt: previous.at,
    detectionRate: d(previous.summary.detectionRate, current.summary.detectionRate) ?? 0,
    falseFailedRate: d(previous.summary.falseFailedRate, current.summary.falseFailedRate) ?? 0,
    blockedRate: d(previous.summary.blockedRate, current.summary.blockedRate) ?? 0,
    planAcceptanceRate: d(previous.summary.planAcceptanceRate, current.summary.planAcceptanceRate) ?? 0,
    ...optional(
      "criterionCoverageRate",
      d(previous.summary.criterionCoverageRate, current.summary.criterionCoverageRate),
    ),
    ...optional(
      "authorFirstTryShare",
      d(previous.scorecard?.author.firstTryShare, current.scorecard?.author.firstTryShare),
    ),
    ...optional(
      "plannerAverageFlags",
      d(previous.scorecard?.planner.averageFlags, current.scorecard?.planner.averageFlags),
    ),
    ...optional(
      "plannerAverageGaps",
      d(previous.scorecard?.planner.averageGaps, current.scorecard?.planner.averageGaps),
    ),
  };
}

/**
 * Compares benchmark passes without and with the knowledge base (REQ-KNOW-11/AC1): every rate of the pass with
 * documentation minus the pass without it.
 */
export function compareKnowledge(cases: readonly BenchCaseResult[]): NonNullable<BenchReport["comparison"]> {
  const without = summariseBench(cases.filter((c) => c.knowledge === false));
  const withDocs = summariseBench(cases.filter((c) => c.knowledge === true));
  const d = (k: Rate): number => Number((withDocs[k] - without[k]).toFixed(3));
  return {
    without,
    with: withDocs,
    delta: {
      detectionRate: d("detectionRate"),
      falseFailedRate: d("falseFailedRate"),
      blockedRate: d("blockedRate"),
      planAcceptanceRate: d("planAcceptanceRate"),
    },
  };
}

const ratio = (n: number, d: number): number => (d === 0 ? 0 : Number((n / d).toFixed(3)));

/**
 * Summarises benchmark cases (REQ-LLM-06/AC2): detection rate over bug cases, false-FAILED rate over
 * clean cases, BLOCKED rate over all test cases, plan acceptance, time, tokens and cost.
 *
 * @param cases - Per-case results.
 */
export function summariseBench(cases: readonly BenchCaseResult[]): BenchSummary {
  const bugs = cases.filter((c) => c.expect === "detect");
  const clean = cases.filter((c) => c.expect === "all_passed");
  const tests = cases.reduce((n, c) => n + Object.keys(c.statuses).length, 0);
  const priced = cases.filter((c) => c.costUsd !== undefined);
  const withCriterion = cases.filter((c) => c.criterionCovered !== undefined);
  return {
    detectionRate: ratio(bugs.filter((c) => c.detected === true).length, bugs.length),
    falseFailedRate: ratio(clean.filter((c) => c.falseFailed > 0).length, clean.length),
    blockedRate: ratio(
      cases.reduce((n, c) => n + c.blocked, 0),
      tests,
    ),
    planAcceptanceRate: ratio(cases.filter((c) => c.planAccepted).length, cases.length),
    durationMs: cases.reduce((n, c) => n + c.durationMs, 0),
    tokens: cases.reduce((n, c) => n + c.tokens, 0),
    ...(priced.length > 0
      ? { costUsd: Number(priced.reduce((n, c) => n + (c.costUsd ?? 0), 0).toFixed(4)) }
      : {}),
    ...(withCriterion.length > 0
      ? {
          criterionCoverageRate: ratio(
            withCriterion.filter((c) => c.criterionCovered === true).length,
            withCriterion.length,
          ),
        }
      : {}),
  };
}

/** Renders the summary as a Markdown table. */
export function formatBench(report: BenchReport): string {
  const s = report.summary;
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
  return [
    `Model ${report.model} (${report.role})`,
    "",
    "| Case | Ticket | Flags | Plan | Statuses | Result |",
    "|---|---|---|---|---|---|",
    ...report.cases.map(
      (c) =>
        `| ${c.id}${c.knowledge === undefined || report.knowledge !== "compare" ? "" : c.knowledge ? " (docs)" : " (no docs)"} | ${c.ticket} | ${c.flags.join(", ") || "–"} | ${c.planAccepted ? "accepted" : "rejected"} | ${
          Object.entries(c.statuses)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ") || "–"
        } | ${c.error ? `error: ${c.error}` : c.expect === "detect" ? (c.detected === true ? "detected" : "missed") : c.falseFailed > 0 ? `${String(c.falseFailed)} false FAILED` : "clean"} |`,
    ),
    "",
    `Detection ${pct(s.detectionRate)} · false FAILED ${pct(s.falseFailedRate)} · BLOCKED ${pct(s.blockedRate)} · plan acceptance ${pct(s.planAcceptanceRate)} · ${String(Math.round(s.durationMs / 1000))} s · ${String(s.tokens)} tokens${s.costUsd === undefined ? "" : ` · $${s.costUsd.toFixed(4)}`}`,
    ...(s.criterionCoverageRate === undefined
      ? []
      : [`Plans covering the bug's criterion ${pct(s.criterionCoverageRate)}`]),
    ...(report.scorecard ? ["", ...formatScorecard(report.scorecard)] : []),
    ...(report.sincePrevious ? ["", formatChanges(report.sincePrevious)] : []),
    ...(report.comparison ? ["", formatComparison(report.comparison)] : []),
  ].join("\n");
}

/** The agent scorecard as lines (REQ-LLM-14/AC4). */
function formatScorecard(card: AgentScorecard): string[] {
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
  return [
    "| Role | Model | Calls | p95 | Steps without repair | Guard denials |",
    "|---|---|---|---|---|---|",
    ...card.roles.map(
      (r) =>
        `| ${r.role} | ${r.model} | ${String(r.calls)} | ${(r.p95Ms / 1000).toFixed(1)} s | ${pct(r.noRepairShare)} | ${String(r.guardDenials)} |`,
    ),
    `Author right on the first try ${pct(card.author.firstTryShare)} · planner ${card.planner.averageFlags.toFixed(1)} flags and ${card.planner.averageGaps.toFixed(1)} coverage gaps per plan`,
  ];
}

/** Changes since the previous benchmark of the same model (REQ-LLM-14/AC4). */
function formatChanges(c: BenchChanges): string {
  const parts = [
    `detection ${signedPct(c.detectionRate)}`,
    `false FAILED ${signedPct(c.falseFailedRate)}`,
    `BLOCKED ${signedPct(c.blockedRate)}`,
    `plan acceptance ${signedPct(c.planAcceptanceRate)}`,
    ...(c.criterionCoverageRate === undefined
      ? []
      : [`criterion coverage ${signedPct(c.criterionCoverageRate)}`]),
    ...(c.authorFirstTryShare === undefined ? [] : [`author first try ${signedPct(c.authorFirstTryShare)}`]),
    ...(c.plannerAverageFlags === undefined
      ? []
      : [`planner flags ${c.plannerAverageFlags >= 0 ? "+" : ""}${c.plannerAverageFlags.toFixed(1)}`]),
    ...(c.plannerAverageGaps === undefined
      ? []
      : [`coverage gaps ${c.plannerAverageGaps >= 0 ? "+" : ""}${c.plannerAverageGaps.toFixed(1)}`]),
  ];
  return `Since ${c.previousAt.slice(0, 10)}: ${parts.join(" · ")}`;
}

const signedPct = (x: number): string => `${x > 0 ? "+" : ""}${(x * 100).toFixed(0)} pp`;

/** The knowledge base comparison as a Markdown table (REQ-KNOW-11/AC1). */
function formatComparison(c: NonNullable<BenchReport["comparison"]>): string {
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
  const row = (name: string, k: Rate) =>
    `| ${name} | ${pct(c.without[k])} | ${pct(c.with[k])} | ${signedPct(c.delta[k])} |`;
  return [
    "Knowledge base: without vs with",
    "",
    "| Metric | Without | With | Difference |",
    "|---|---|---|---|",
    row("Detection", "detectionRate"),
    row("False FAILED", "falseFailedRate"),
    row("BLOCKED", "blockedRate"),
    row("Plan accepted without edits", "planAcceptanceRate"),
  ].join("\n");
}

/** The latest earlier report of the same model and role in a folder, if any. */
async function previousReport(dir: string, current: BenchReport): Promise<BenchReport | undefined> {
  let latest: BenchReport | undefined;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith(".json")) continue;
    try {
      const r = JSON.parse(await readFile(join(dir, name), "utf8")) as BenchReport;
      if (r.model !== current.model || r.role !== current.role || r.at >= current.at) continue;
      if (latest === undefined || r.at > latest.at) latest = r;
    } catch {
      // Not a report.
    }
  }
  return latest;
}

/** Output of a sub-command, kept out of the benchmark's own output. */
const quietIO = (cwd: string): CommandIO & { log: string[] } => {
  const log: string[] = [];
  return { cwd, write: (t) => log.push(t), writeError: (t) => log.push(t), log };
};

/**
 * `qajitsu bench --model <ref> [--role <role>] [--cases <file>] [--out <dir>]`: runs the seeded-bug
 * cases end to end with a real model and reports detection, false FAILED, BLOCKED, plan acceptance,
 * time and cost (REQ-LLM-06). Each case is a fresh run: fetch, plan, approve (no review), and
 * `run --build` with its bug flags. Statuses still come from the runner; a weak model can only score
 * badly. Never part of PR CI: real models cost money and are non-deterministic (REQ-LLM-06/AC3).
 *
 * @returns 0 when the benchmark completed (whatever the scores), 3 on configuration errors.
 */
export async function runBench(
  options: {
    readonly model: string;
    readonly role?: string | undefined;
    readonly cases?: string | undefined;
    readonly out?: string | undefined;
    readonly knowledge?: string | undefined;
  },
  io: CommandIO,
  ports: RuntimePorts & ModelPorts & RunPorts,
  review: ReviewPorts,
): Promise<number> {
  try {
    const project = await loadProject(io.cwd, ports.project);
    const casesFile = options.cases ?? join(project.qaDir, "bench.yaml");
    const parsed = BenchCasesSchema.safeParse(
      parse(await readFile(resolve(io.cwd, casesFile), "utf8")) as unknown,
    );
    if (!parsed.success)
      throw new ConfigError("BENCH_CASES_INVALID", `Invalid benchmark cases in ${casesFile}.`, {
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    const base = project.config.build?.base_service;
    if (!base)
      throw new ConfigError(
        "BUILD_NOT_CONFIGURED",
        "qajitsu bench needs `build` in .qa/qa.project.yaml.",
        {},
      );
    const root = resolveWorkspaceRoot({
      configured: project.config.workspace.root,
      home: ports.home,
      cwd: project.qaDir,
    });
    const mode = options.knowledge ?? "on";
    if (mode !== "on" && mode !== "off" && mode !== "compare")
      throw new ConfigError("BENCH_KNOWLEDGE_INVALID", "--knowledge must be on, off or compare.", {});
    const knowledgeDir = project.project?.paths.knowledge;
    if (
      mode === "compare" &&
      (knowledgeDir === undefined || (await readKnowledgeIndex(knowledgeDir)) === undefined)
    )
      throw new ConfigError(
        "KNOWLEDGE_EMPTY",
        "--knowledge compare needs a knowledge base: add documents with 'qajitsu knowledge add'.",
        {},
      );
    // REQ-KNOW-11/AC1: in compare mode every case runs without, then with the knowledge base.
    const passes: (boolean | undefined)[] =
      mode === "compare" ? [false, true] : [mode === "off" ? false : undefined];
    const results: BenchCaseResult[] = [];
    const digests: RunDigest[] = [];
    for (const withDocs of passes)
      for (const c of parsed.data.cases) {
        const benchPorts = {
          ...ports,
          modelOverride: { ref: options.model, role: options.role },
          ...(withDocs === false ? { knowledgeDisabled: true } : {}),
        };
        const label =
          withDocs === undefined ? "" : withDocs ? " (with knowledge base)" : " (without knowledge base)";
        io.write(`${c.id}: ${c.ticket}${c.flags.length > 0 ? ` with ${c.flags.join(", ")}` : ""}${label}…\n`);
        const started = ports.now().getTime();
        const sub = quietIO(io.cwd);
        const fetched = await runFetch(
          c.ticket,
          { ref: c.ref === undefined ? [] : [c.ref] },
          sub,
          benchPorts,
        );
        const runId = (await readRunIndex(root, c.ticket)).latest;
        // Marked before anything else: publish refuses benchmark runs.
        if (fetched === 0 && runId !== undefined) {
          const ws = await openRunWorkspace(root, c.ticket, runId);
          await ws.update({
            data: { ...ws.record.data, bench: { case: c.id, model: options.model, flags: c.flags } },
          });
        }
        const planned =
          fetched === 0 && runId !== undefined
            ? await runPlan(c.ticket, { run: runId }, sub, benchPorts, review)
            : 3;
        const approved =
          planned === 0
            ? // Recorded as an automatic approval by the benchmark, never as a person's.
              // The benchmark measures what a plan finds: a plan that misses part of the ticket runs and scores lower.
              await runApprove(
                c.ticket,
                { run: runId, confirmOpenQuestions: true, confirmUncovered: true },
                sub,
                benchPorts,
                {
                  ...review,
                  user: `bench:${review.user}`,
                },
              )
            : 3;
        if (approved === 0)
          await runRun(
            c.ticket,
            { run: runId, build: true, set: c.flags.map((f) => `${base}.${f}=1`) },
            sub,
            benchPorts,
          );
        const dir = join(root, c.ticket, runId ?? "missing");
        const record = RunRecordSchema.safeParse(
          JSON.parse(await readFile(join(dir, "run.json"), "utf8").catch(() => "null")) as unknown,
        );
        const statuses = (record.success ? record.data.data["results"] : undefined) as
          Record<string, string> | undefined;
        const { events } = parseEventLines(
          await readFile(join(dir, "journal", "events.jsonl"), "utf8").catch(() => ""),
        );
        const usage = events
          .filter((e) => e.event === "model.usage")
          .map((e) => (e.details ?? {}) as Record<string, unknown>);
        const costs = usage.map((u) => u["costUsd"]).filter((x): x is number => typeof x === "number");
        const values = Object.values(statuses ?? {});
        if (record.success)
          digests.push(
            digestRun({
              ticket: c.ticket,
              runId: record.data.runId,
              createdAt: record.data.createdAt,
              data: record.data.data,
              events,
              attemptsMs: [],
            }),
          );
        // REQ-LLM-14/AC4: ground truth of the demo shop: the plan has a case for the criterion the bug breaks.
        const criterion = "detects" in c.expect ? c.expect.criterion : undefined;
        const covered =
          criterion === undefined
            ? undefined
            : await readFile(join(dir, "plan", "plan.approved.yaml"), "utf8").then(
                (text) => {
                  const plan = parse(text) as { cases?: { source?: { kind?: string; id?: string }[] }[] };
                  return (plan.cases ?? []).some((pc) =>
                    (pc.source ?? []).some((src) => src.kind === "ac" && src.id === criterion),
                  );
                },
                () => false,
              );
        results.push({
          id: c.id,
          ticket: c.ticket,
          flags: c.flags,
          expect: "detects" in c.expect ? "detect" : "all_passed",
          planAccepted: planned === 0 && approved === 0,
          statuses: statuses ?? {},
          ...("detects" in c.expect ? { detected: values.includes("FAILED") } : {}),
          falseFailed: "detects" in c.expect ? 0 : values.filter((v) => v === "FAILED").length,
          blocked: values.filter((v) => v === "BLOCKED").length,
          durationMs: ports.now().getTime() - started,
          tokens: usage.reduce(
            (n, u) => n + Number(u["inputTokens"] ?? 0) + Number(u["outputTokens"] ?? 0),
            0,
          ),
          ...(costs.length > 0 ? { costUsd: costs.reduce((a, b) => a + b, 0) } : {}),
          ...(withDocs === undefined ? {} : { knowledge: withDocs }),
          ...(covered === undefined ? {} : { criterionCovered: covered }),
          ...(statuses === undefined
            ? {
                error: (sub.log.filter((l) => l.startsWith("Error")).at(-1) ?? "did not finish")
                  .trim()
                  .slice(0, 300),
              }
            : {}),
        });
      }
    const outDir = options.out
      ? isAbsolute(options.out)
        ? options.out
        : resolve(io.cwd, options.out)
      : join(project.project?.paths.exports ?? project.projectDir, "bench-results");
    await mkdir(outDir, { recursive: true });
    const current: BenchReport = {
      model: options.model,
      role: options.role ?? "all",
      at: ports.now().toISOString(),
      knowledge: mode,
      cases: results,
      summary: summariseBench(results),
      scorecard: agentScorecard(digests),
      ...(mode === "compare" ? { comparison: compareKnowledge(results) } : {}),
    };
    // REQ-LLM-14/AC4: the previous report of the same model and role, to see what changed.
    const previous = await previousReport(outDir, current);
    const report: BenchReport = previous
      ? { ...current, sincePrevious: benchChanges(previous, current) }
      : current;
    const file = join(
      outDir,
      `${report.at.slice(0, 10)}-${options.model.replace(/[^a-zA-Z0-9.-]+/g, "_")}.json`,
    );
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    io.write(`${formatBench(report)}\nReport: ${file}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
}
