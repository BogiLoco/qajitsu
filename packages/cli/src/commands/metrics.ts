import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CaseResultFileSchema,
  QajitsuError,
  RunRecordSchema,
  listTickets,
  parseEventLines,
  readRunIndex,
  resolveWorkspaceRoot,
} from "@qajitsu/core";
import {
  agentScorecard,
  costInsights,
  digestRun,
  mergeContextUsage,
  planInsights,
  timeInsights,
  weeklyCosts,
  type RunDigest,
} from "@qajitsu/report";
import type { RuntimePorts } from "../adapters.js";
import { loadProject } from "../project.js";
import type { CommandIO } from "./fetch.js";

/** One metric sample. */
export interface Sample {
  readonly name: string;
  readonly help: string;
  readonly type: "gauge" | "counter";
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

/**
 * The digest of every run of a workspace (REQ-LLM-11/AC2), computed from each run's record, journal and results.
 *
 * @param root - Workspace root.
 */
export async function readRunDigests(root: string): Promise<RunDigest[]> {
  const digests: RunDigest[] = [];
  for (const ticket of await listTickets(root))
    for (const entry of (await readRunIndex(root, ticket)).runs) {
      const dir = join(root, ticket, entry.runId);
      const parsed = RunRecordSchema.safeParse(
        JSON.parse(await readFile(join(dir, "run.json"), "utf8").catch(() => "null")) as unknown,
      );
      if (!parsed.success) continue;
      const attemptsMs: number[] = [];
      for (const file of (await readdir(join(dir, "results")).catch(() => [] as string[])).filter((f) =>
        f.endsWith(".json"),
      )) {
        const r = CaseResultFileSchema.safeParse(
          JSON.parse(await readFile(join(dir, "results", file), "utf8").catch(() => "null")) as unknown,
        );
        if (r.success) for (const a of r.data.attempts) attemptsMs.push(a.durationMs ?? 0);
      }
      const { events } = parseEventLines(
        await readFile(join(dir, "journal", "events.jsonl"), "utf8").catch(() => ""),
      );
      digests.push(
        digestRun({
          ticket,
          runId: parsed.data.runId,
          createdAt: parsed.data.createdAt,
          data: parsed.data.data,
          events,
          attemptsMs,
        }),
      );
    }
  return digests;
}

/** Cost samples of a project (REQ-LLM-11/AC2+AC4): per verified ticket, per role, per week. */
export function costSamples(digests: readonly RunDigest[]): Sample[] {
  const all = costInsights(digests);
  const gauge = (name: string, help: string, labels: Record<string, string>, value: number): Sample => ({
    name,
    help,
    type: "gauge",
    labels,
    value,
  });
  return [
    gauge("qajitsu_verified_tickets", "Tickets with a GO or NO-GO decision.", {}, all.verifiedTickets),
    ...(all.costPerVerifiedTicketUsd === undefined
      ? []
      : [
          gauge(
            "qajitsu_cost_per_verified_ticket_usd",
            "Model cost of every run over the verified tickets (a lower bound when cost_known is 0).",
            { cost_known: all.costKnown ? "1" : "0" },
            all.costPerVerifiedTicketUsd,
          ),
        ]),
    ...Object.entries(all.byRole).map(([role, r]) =>
      gauge("qajitsu_role_cost_usd", "Model cost per agent role.", { role }, r.costUsd),
    ),
    gauge(
      "qajitsu_runner_minutes_per_ticket",
      "Test execution minutes per ticket.",
      {},
      all.runnerMinutesPerTicket,
    ),
    gauge(
      "qajitsu_stages_without_model_ratio",
      "Share of pipeline stages that called no model.",
      {},
      all.stagesWithoutModelShare,
    ),
    ...weeklyCosts(digests).flatMap(({ week, insights }) =>
      insights.costPerVerifiedTicketUsd === undefined
        ? []
        : [
            gauge(
              "qajitsu_week_cost_per_verified_ticket_usd",
              "Cost per verified ticket by ISO week (trend).",
              { week },
              insights.costPerVerifiedTicketUsd,
            ),
          ],
    ),
  ];
}

/** Time samples of a project (REQ-NFR-11/AC2+AC4): medians per run by category, per stage, and per QAJitsu version. */
export function timeSamples(digests: readonly RunDigest[]): Sample[] {
  const t = timeInsights(digests);
  if (t.runs === 0) return [];
  const seconds = (ms: number): number => Number((ms / 1000).toFixed(3));
  const gauge = (name: string, help: string, labels: Record<string, string>, ms: number): Sample => ({
    name,
    help,
    type: "gauge",
    labels,
    value: seconds(ms),
  });
  return [
    ...(
      [
        ["active", t.perRun.activeMs],
        ["model", t.perRun.modelMs],
        ["environment", t.perRun.environmentMs],
        ["tests", t.perRun.testsMs],
        ["qajitsu", t.perRun.otherMs],
      ] as const
    ).map(([category, ms]) =>
      gauge("qajitsu_run_time_seconds", "Median time of a run by category.", { category }, ms),
    ),
    ...Object.entries(t.stages).map(([stage, ms]) =>
      gauge("qajitsu_stage_seconds", "Median time of a stage in a run.", { stage }, ms),
    ),
    ...Object.entries(t.byVersion).flatMap(([version, stages]) =>
      Object.entries(stages).map(([stage, ms]) =>
        gauge(
          "qajitsu_stage_seconds_by_version",
          "Median stage time by QAJitsu version (release trend).",
          { stage, qajitsu_version: version },
          ms,
        ),
      ),
    ),
  ];
}

const gauge = (name: string, help: string, labels: Record<string, string>, value: number): Sample => ({
  name,
  help,
  type: "gauge",
  labels,
  value,
});

/** Plan and test quality of a project (REQ-PLAN-16/AC3). */
export function qualitySamples(digests: readonly RunDigest[]): Sample[] {
  const q = planInsights(digests);
  return [
    gauge(
      "qajitsu_plan_accepted_unchanged_ratio",
      "Approved runs whose first plan version was approved.",
      {},
      Number(q.approvedUnchangedShare.toFixed(3)),
    ),
    gauge(
      "qajitsu_plan_revision_rounds_avg",
      "Average revision rounds before approval.",
      {},
      q.averageRevisionRounds,
    ),
    gauge(
      "qajitsu_readiness_stopped_ratio",
      "Share of checked tickets the readiness gate did not find READY.",
      {},
      q.readinessStoppedShare,
    ),
    gauge(
      "qajitsu_false_failed_recorded_ratio",
      "FAILED cases a person recorded as no product bug (qj feedback), over all FAILED cases.",
      {},
      q.falseFailedShare,
    ),
    gauge("qajitsu_auditor_downgrades", "PASSED cases the auditor downgraded.", {}, q.auditorDowngrades),
    gauge(
      "qajitsu_escaped_defects",
      "Defects found later and linked to a run (qj feedback --escaped).",
      {},
      q.escapedDefects,
    ),
  ];
}

/**
 * Context metrics per role and model (REQ-CTX-18/AC1): input tokens by source kind, reductions by action, catalogue
 * reads and searches, and the provider's prompt cache hit rate.
 */
export function contextSamples(digests: readonly RunDigest[]): Sample[] {
  return mergeContextUsage(digests.map((d) => d.context ?? [])).flatMap((u) => {
    const labels = { role: u.role, model: u.model };
    return [
      ...Object.entries(u.tokensByKind).map(([kind, n]) =>
        gauge(
          "qajitsu_context_input_tokens",
          "Estimated input tokens by fragment kind.",
          { ...labels, kind },
          n,
        ),
      ),
      ...Object.entries(u.reductions).map(([action, n]) =>
        gauge("qajitsu_context_reductions", "Context reductions by action.", { ...labels, action }, n),
      ),
      gauge("qajitsu_context_calls", "Assembled model inputs.", labels, u.calls),
      gauge("qajitsu_context_reads", "read_context calls (handles read in full).", labels, u.reads),
      gauge("qajitsu_context_searches", "search_context calls.", labels, u.searches),
      gauge(
        "qajitsu_context_cache_hit_ratio",
        "Share of input tokens served from the provider's prompt cache.",
        labels,
        u.inputTokens === 0 ? 0 : Number((u.cachedInputTokens / u.inputTokens).toFixed(3)),
      ),
    ];
  });
}

/** The agent scorecard (REQ-LLM-14/AC3), per role and model. */
export function scorecardSamples(digests: readonly RunDigest[]): Sample[] {
  const card = agentScorecard(digests);
  return [
    ...card.roles.flatMap((r) => {
      const labels = { role: r.role, model: r.model };
      return [
        gauge("qajitsu_agent_calls", "Model calls per role and model.", labels, r.calls),
        gauge("qajitsu_agent_cost_usd", "Model cost per role and model.", labels, r.costUsd),
        gauge(
          "qajitsu_agent_latency_p95_seconds",
          "95th percentile of call duration.",
          labels,
          r.p95Ms / 1000,
        ),
        gauge(
          "qajitsu_agent_no_repair_ratio",
          "Share of agent steps that needed no repair.",
          labels,
          r.noRepairShare,
        ),
        gauge("qajitsu_agent_guard_denials", "Tool calls the guard denied.", labels, r.guardDenials),
      ];
    }),
    gauge(
      "qajitsu_author_first_try_ratio",
      "Share of specs that passed every check on the first answer.",
      {},
      card.author.firstTryShare,
    ),
    ...Object.entries(card.author.findings).map(([check, n]) =>
      gauge(
        "qajitsu_author_findings",
        "Problems the checks found in rejected specs, by check.",
        { check },
        n,
      ),
    ),
    ...Object.entries(card.author.rules).map(([rule, n]) =>
      gauge("qajitsu_author_quality_rule", "Quality gate findings in rejected specs, by rule.", { rule }, n),
    ),
    gauge(
      "qajitsu_planner_flags_avg",
      "Average flagged expectations in a plan's last version.",
      {},
      card.planner.averageFlags,
    ),
    gauge(
      "qajitsu_planner_gaps_avg",
      "Average coverage gaps in a plan's last version.",
      {},
      card.planner.averageGaps,
    ),
    gauge(
      "qajitsu_healer_accepted_ratio",
      "Share of heals the assertion lock accepted.",
      {},
      card.healer.acceptedShare,
    ),
  ];
}

/** Groups BLOCKED reasons into a few stable categories (labels must stay low-cardinality). */
export function blockedReason(error: string | undefined): string {
  const e = error ?? "";
  if (e.startsWith("environment did not start")) return "env_start_failed";
  if (e.startsWith("environment not healthy")) return "env_unhealthy";
  if (e.startsWith("mobile device not available")) return "device_unavailable";
  if (e.startsWith("spec failed static checks")) return "spec_rejected";
  if (e.startsWith("author could not produce")) return "author_failed";
  if (/budget/i.test(e)) return "token_budget";
  if (/timeout|timed out/i.test(e)) return "timeout";
  return "other";
}

/**
 * Collects metrics over every run in the workspace (REQ-OBS-04/AC1): runs by status, case statuses per
 * environment, BLOCKED reasons, duration, tokens and cost per ticket, plan acceptance without changes,
 * false-FAILED rate of clean benchmark runs, guard denials, and how long running runs have been running.
 *
 * @param root - Workspace root.
 * @param now - Current time (for running runs).
 */
export async function collectMetrics(root: string, now: Date): Promise<Sample[]> {
  const samples: Sample[] = [];
  const add = (
    name: string,
    help: string,
    type: Sample["type"],
    labels: Record<string, string>,
    value: number,
  ) => {
    const existing = samples.findIndex(
      (s) => s.name === name && JSON.stringify(s.labels) === JSON.stringify(labels),
    );
    if (existing >= 0) {
      const s = samples[existing];
      if (s) samples[existing] = { ...s, value: s.value + value };
    } else samples.push({ name, help, type, labels, value });
  };
  let cleanBench = 0;
  let cleanBenchWithFailed = 0;
  for (const ticket of await listTickets(root)) {
    for (const entry of (await readRunIndex(root, ticket)).runs) {
      const dir = join(root, ticket, entry.runId);
      const parsed = RunRecordSchema.safeParse(
        JSON.parse(await readFile(join(dir, "run.json"), "utf8").catch(() => "null")) as unknown,
      );
      if (!parsed.success) continue;
      const record = parsed.data;
      add("qajitsu_runs", "Runs by lifecycle status.", "gauge", { status: record.status }, 1);
      const env = (record.data["environment"] as { name?: string } | undefined)?.name ?? "none";
      const results = (record.data["results"] ?? {}) as Record<string, string>;
      for (const status of Object.values(results))
        add(
          "qajitsu_cases",
          "Test cases by final status and environment.",
          "gauge",
          { status, environment: env },
          1,
        );
      for (const file of (await readdir(join(dir, "results")).catch(() => [])).filter((f) =>
        f.endsWith(".json"),
      )) {
        const r = CaseResultFileSchema.safeParse(
          JSON.parse(await readFile(join(dir, "results", file), "utf8").catch(() => "null")) as unknown,
        );
        const caseId = file.slice(0, -5);
        if (r.success && results[caseId] === "BLOCKED")
          add(
            "qajitsu_blocked",
            "BLOCKED cases by reason category.",
            "gauge",
            { reason: blockedReason(r.data.attempts.at(-1)?.error), environment: env },
            1,
          );
      }
      const started = Date.parse(record.createdAt);
      if (record.status === "running")
        add(
          "qajitsu_run_running_seconds",
          "Seconds a run has been running (stuck runs).",
          "gauge",
          { ticket, run: record.runId },
          Math.round((now.getTime() - started) / 1000),
        );
      else
        add(
          "qajitsu_run_duration_seconds",
          "Total wall time of runs per ticket.",
          "counter",
          { ticket },
          Math.round((Date.parse(record.updatedAt) - started) / 1000),
        );
      const { events } = parseEventLines(
        await readFile(join(dir, "journal", "events.jsonl"), "utf8").catch(() => ""),
      );
      let tokens = 0;
      let cost = 0;
      for (const e of events) {
        const d = (e.details ?? {}) as Record<string, unknown>;
        if (e.event === "model.usage") {
          tokens += Number(d["inputTokens"] ?? 0) + Number(d["outputTokens"] ?? 0);
          cost += typeof d["costUsd"] === "number" ? d["costUsd"] : 0;
        }
        if (e.event === "tool_denied")
          add(
            "qajitsu_guard_denied",
            "Agent tool calls denied by the guard, by reason code.",
            "counter",
            { code: typeof d["code"] === "string" ? d["code"] : "unknown" },
            1,
          );
      }
      add("qajitsu_tokens", "Model tokens per ticket.", "counter", { ticket }, tokens);
      add(
        "qajitsu_cost_usd",
        "Estimated model cost in USD per ticket.",
        "counter",
        { ticket },
        Number(cost.toFixed(6)),
      );
      const bench = record.data["bench"] as { flags?: string[] } | undefined;
      if (bench && (bench.flags ?? []).length === 0 && Object.keys(results).length > 0) {
        cleanBench += 1;
        if (Object.values(results).includes("FAILED")) cleanBenchWithFailed += 1;
      }
    }
  }
  const digests = await readRunDigests(root);
  samples.push(
    ...costSamples(digests),
    ...timeSamples(digests),
    ...qualitySamples(digests),
    ...scorecardSamples(digests),
    ...contextSamples(digests),
  );
  samples.push({
    name: "qajitsu_false_failed_ratio",
    help: "Clean benchmark runs (no bug flag) with a FAILED case.",
    type: "gauge",
    labels: {},
    value: cleanBench === 0 ? 0 : Number((cleanBenchWithFailed / cleanBench).toFixed(3)),
  });
  return samples;
}

/** Prometheus text exposition format (for the node_exporter textfile collector or a pushgateway). */
export function renderPrometheus(samples: readonly Sample[]): string {
  const out: string[] = [];
  const escape = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  for (const name of [...new Set(samples.map((s) => s.name))]) {
    const group = samples.filter((s) => s.name === name);
    out.push(`# HELP ${name} ${group[0]?.help ?? ""}`, `# TYPE ${name} ${group[0]?.type ?? "gauge"}`);
    for (const s of group) {
      const labels = Object.entries(s.labels)
        .map(([k, v]) => `${k}="${escape(v)}"`)
        .join(",");
      out.push(`${name}${labels ? `{${labels}}` : ""} ${String(s.value)}`);
    }
  }
  return `${out.join("\n")}\n`;
}

/**
 * `qajitsu metrics [--format prometheus|json] [--out <file>]` (REQ-OBS-04): metrics over every run, for
 * dashboards and alerts (example rules: docs/ops/prometheus-alerts.yml).
 */
export async function runMetrics(
  options: { readonly format?: string | undefined; readonly out?: string | undefined },
  io: CommandIO,
  ports: RuntimePorts,
): Promise<number> {
  try {
    const project = await loadProject(io.cwd, ports.project);
    const root = resolveWorkspaceRoot({
      configured: project.config.workspace.root,
      home: ports.home,
      cwd: project.qaDir,
    });
    const samples = await collectMetrics(root, ports.now());
    const text =
      options.format === "json" ? `${JSON.stringify(samples, null, 2)}\n` : renderPrometheus(samples);
    if (options.out !== undefined) {
      const file = resolve(io.cwd, options.out);
      await writeFile(`${file}.tmp`, text, "utf8");
      await rename(`${file}.tmp`, file);
      io.write(`Wrote ${String(samples.length)} sample(s) to ${file}\n`);
    } else io.write(text);
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
}
