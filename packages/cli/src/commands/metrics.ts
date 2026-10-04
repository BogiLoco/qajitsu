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
  let approved = 0;
  let unchanged = 0;
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
      const approval = record.data["approval"] as { version?: number } | undefined;
      if (approval?.version !== undefined) {
        approved += 1;
        if (approval.version === 1) unchanged += 1;
      }
      const bench = record.data["bench"] as { flags?: string[] } | undefined;
      if (bench && (bench.flags ?? []).length === 0 && Object.keys(results).length > 0) {
        cleanBench += 1;
        if (Object.values(results).includes("FAILED")) cleanBenchWithFailed += 1;
      }
    }
  }
  samples.push({
    name: "qajitsu_plan_accepted_unchanged_ratio",
    help: "Approved runs whose first plan version was approved.",
    type: "gauge",
    labels: {},
    value: approved === 0 ? 0 : Number((unchanged / approved).toFixed(3)),
  });
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
    const project = await loadProject(io.cwd);
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
