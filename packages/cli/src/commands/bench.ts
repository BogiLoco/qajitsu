import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  ConfigError,
  QajitsuError,
  RunRecordSchema,
  TicketKeySchema,
  openRunWorkspace,
  parseEventLines,
  readRunIndex,
  resolveWorkspaceRoot,
} from "@qajitsu/core";
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
          z.strictObject({ detects: z.string().min(1) }),
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
}

/** Benchmark report written to `<out>/<date>-<model>.json`. */
export interface BenchReport {
  readonly model: string;
  readonly role: string;
  readonly at: string;
  readonly cases: readonly BenchCaseResult[];
  readonly summary: {
    readonly detectionRate: number;
    readonly falseFailedRate: number;
    readonly blockedRate: number;
    readonly planAcceptanceRate: number;
    readonly durationMs: number;
    readonly tokens: number;
    readonly costUsd?: number | undefined;
  };
}

const ratio = (n: number, d: number): number => (d === 0 ? 0 : Number((n / d).toFixed(3)));

/**
 * Summarises benchmark cases (REQ-LLM-06/AC2): detection rate over bug cases, false-FAILED rate over
 * clean cases, BLOCKED rate over all test cases, plan acceptance, time, tokens and cost.
 *
 * @param cases - Per-case results.
 */
export function summariseBench(cases: readonly BenchCaseResult[]): BenchReport["summary"] {
  const bugs = cases.filter((c) => c.expect === "detect");
  const clean = cases.filter((c) => c.expect === "all_passed");
  const tests = cases.reduce((n, c) => n + Object.keys(c.statuses).length, 0);
  const priced = cases.filter((c) => c.costUsd !== undefined);
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
        `| ${c.id} | ${c.ticket} | ${c.flags.join(", ") || "–"} | ${c.planAccepted ? "accepted" : "rejected"} | ${
          Object.entries(c.statuses)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ") || "–"
        } | ${c.error ? `error: ${c.error}` : c.expect === "detect" ? (c.detected === true ? "detected" : "missed") : c.falseFailed > 0 ? `${String(c.falseFailed)} false FAILED` : "clean"} |`,
    ),
    "",
    `Detection ${pct(s.detectionRate)} · false FAILED ${pct(s.falseFailedRate)} · BLOCKED ${pct(s.blockedRate)} · plan acceptance ${pct(s.planAcceptanceRate)} · ${String(Math.round(s.durationMs / 1000))} s · ${String(s.tokens)} tokens${s.costUsd === undefined ? "" : ` · $${s.costUsd.toFixed(4)}`}`,
  ].join("\n");
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
    const benchPorts = { ...ports, modelOverride: { ref: options.model, role: options.role } };
    const results: BenchCaseResult[] = [];
    for (const c of parsed.data.cases) {
      io.write(`${c.id}: ${c.ticket}${c.flags.length > 0 ? ` with ${c.flags.join(", ")}` : ""}…\n`);
      const started = ports.now().getTime();
      const sub = quietIO(io.cwd);
      const fetched = await runFetch(c.ticket, { ref: c.ref === undefined ? [] : [c.ref] }, sub, benchPorts);
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
            await runApprove(c.ticket, { run: runId, confirmOpenQuestions: true }, sub, benchPorts, {
              ...review,
              user: `bench:${review.user}`,
            })
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
        tokens: usage.reduce((n, u) => n + Number(u["inputTokens"] ?? 0) + Number(u["outputTokens"] ?? 0), 0),
        ...(costs.length > 0 ? { costUsd: costs.reduce((a, b) => a + b, 0) } : {}),
        ...(statuses === undefined
          ? {
              error: (sub.log.filter((l) => l.startsWith("Error")).at(-1) ?? "did not finish")
                .trim()
                .slice(0, 300),
            }
          : {}),
      });
    }
    const report: BenchReport = {
      model: options.model,
      role: options.role ?? "all",
      at: ports.now().toISOString(),
      cases: results,
      summary: summariseBench(results),
    };
    const outDir = options.out
      ? isAbsolute(options.out)
        ? options.out
        : resolve(io.cwd, options.out)
      : join(project.project?.paths.exports ?? project.projectDir, "bench-results");
    await mkdir(outDir, { recursive: true });
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
