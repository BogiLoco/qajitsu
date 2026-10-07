import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CaseResultFileSchema, RunRecordSchema, TicketKeySchema, type Plan } from "@qajitsu/core";

/** Seconds per case and runner when the project has no history yet. */
const DEFAULT_SECONDS: Readonly<Record<string, number>> = { api: 5, web: 30, mobile: 90 };

/** What past runs of the project say about duration and model use. */
export interface RunHistory {
  readonly runs: number;
  /** Average execution seconds per case, by runner. */
  readonly secondsPerCase: Readonly<Record<string, number>>;
  /** Average model tokens and cost per case of a run (planning, writing specs, checks). */
  readonly tokensPerCase?: number | undefined;
  readonly costPerCase?: number | undefined;
}

/**
 * Reads the project's past runs (results durations, run tokens and cost) for estimates (REQ-PLAN-08/AC2). Runs of the
 * current one are skipped; unreadable files are ignored.
 *
 * @param root - The project's runs folder.
 * @param exclude - Run id to leave out (the run being estimated).
 */
export async function readRunHistory(root: string, exclude?: string): Promise<RunHistory> {
  const durations = new Map<string, number[]>();
  const tokens: number[] = [];
  const costs: number[] = [];
  let runs = 0;
  for (const ticket of await readdir(root).catch(() => [] as string[])) {
    if (!TicketKeySchema.safeParse(ticket).success) continue;
    for (const runId of await readdir(join(root, ticket)).catch(() => [] as string[])) {
      if (!/^\d{8}-\d{4}-[a-z0-9]+$/.test(runId) || runId === exclude) continue;
      const dir = join(root, ticket, runId);
      const files = (await readdir(join(dir, "results")).catch(() => [] as string[])).filter((f) =>
        f.endsWith(".json"),
      );
      if (files.length === 0) continue;
      runs += 1;
      for (const file of files) {
        const r = CaseResultFileSchema.safeParse(
          JSON.parse(await readFile(join(dir, "results", file), "utf8").catch(() => "null")),
        );
        if (!r.success) continue;
        const ms = r.data.attempts.reduce((n, a) => n + (a.durationMs ?? 0), 0);
        if (ms > 0) durations.set(r.data.runner, [...(durations.get(r.data.runner) ?? []), ms / 1000]);
      }
      const record = RunRecordSchema.safeParse(
        JSON.parse(await readFile(join(dir, "run.json"), "utf8").catch(() => "null")),
      );
      if (!record.success) continue;
      const t = Number(record.data.data["tokens"] ?? 0);
      const c = Number(record.data.data["costUsd"] ?? 0);
      if (t > 0) tokens.push(t / files.length);
      if (c > 0) costs.push(c / files.length);
    }
  }
  const avg = (xs: readonly number[]): number | undefined =>
    xs.length === 0 ? undefined : xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    runs,
    secondsPerCase: Object.fromEntries([...durations].map(([k, v]) => [k, avg(v) ?? 0])),
    tokensPerCase: avg(tokens),
    costPerCase: avg(costs),
  };
}

const duration = (s: number): string =>
  s < 60 ? `${String(Math.round(s))} s` : `${String(Math.floor(s / 60))} min ${String(Math.round(s % 60))} s`;

/**
 * The estimate shown before a run (REQ-PLAN-08/AC2): execution time from the number and types of cases (and the
 * browser, viewport and locale runs), model tokens and cost per case from the project's past runs.
 *
 * @param plan - Cases about to run.
 * @param history - Past runs of the project.
 * @param variants - Extra runs per case type, e.g. `{ web: 2 }` for two more browser combinations.
 */
export function formatEstimate(
  plan: Plan,
  history: RunHistory,
  variants: Readonly<Record<string, number>> = {},
): string {
  const byType = new Map<string, number>();
  for (const c of plan.cases)
    byType.set(c.type, (byType.get(c.type) ?? 0) + 1 + (variants[c.type] ?? 0) + (c.locales?.length ?? 0));
  let seconds = 0;
  for (const [type, n] of byType)
    seconds += n * (history.secondsPerCase[type] ?? DEFAULT_SECONDS[type] ?? 30);
  const cases = plan.cases.length;
  const parts = [...byType].map(([type, n]) => `${String(n)} ${type}`).join(" + ");
  const model =
    history.tokensPerCase === undefined
      ? "model use unknown (no past runs with usage)"
      : `models ≈ ${String(Math.round((history.tokensPerCase * cases) / 1000))}k tokens${history.costPerCase === undefined ? "" : ` (~$${(history.costPerCase * cases).toFixed(2)})`}`;
  return `Estimate: ${parts} execution(s) ≈ ${duration(seconds)}; ${model}; ${history.runs > 0 ? `from ${String(history.runs)} past run(s)` : "default timings, no past runs yet"}.`;
}
