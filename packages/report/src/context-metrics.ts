import type { RunEvent } from "@qajitsu/core";

/** How a role on a model used its context in one or more runs (REQ-CTX-18/AC1). */
export interface ContextUsage {
  readonly role: string;
  readonly model: string;
  /** Assembled inputs (one per model call or loop). */
  readonly calls: number;
  /** Estimated input tokens by fragment kind, as the snapshots recorded them. */
  readonly tokensByKind: Readonly<Record<string, number>>;
  /** Reductions by action: handle, trimmed, deduplicated, summarised, compacted. */
  readonly reductions: Readonly<Record<string, number>>;
  readonly reads: number;
  readonly searches: number;
  /** Input tokens the provider reported, and how many of them came from its prompt cache. */
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

type Mutable = {
  -readonly [K in keyof ContextUsage]: ContextUsage[K] extends Readonly<Record<string, number>>
    ? Record<string, number>
    : ContextUsage[K];
};

/**
 * The context usage of a run's journal per role and model (REQ-CTX-18/AC1): snapshots give the tokens by kind and the
 * reductions, `context.read` / `context.search` the catalogue's use (counted for the model the role last assembled
 * for), `context.compacted` the loop compactions, and `model.usage` the provider's input and cached tokens.
 *
 * @param events - The run's journal entries.
 */
export function contextUsage(events: readonly RunEvent[]): ContextUsage[] {
  const rows = new Map<string, Mutable>();
  const lastModel = new Map<string, string>();
  const row = (role: string, model: string): Mutable => {
    const key = `${role}\u0000${model}`;
    let r = rows.get(key);
    if (!r) {
      r = {
        role,
        model,
        calls: 0,
        tokensByKind: {},
        reductions: {},
        reads: 0,
        searches: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
      };
      rows.set(key, r);
    }
    return r;
  };
  for (const e of events) {
    const d = obj(e.details);
    const role = e.actor.name;
    if (e.event === "context.snapshot") {
      const model = typeof d["model"] === "string" ? d["model"] : "unknown";
      lastModel.set(role, model);
      const r = row(typeof d["role"] === "string" ? d["role"] : role, model);
      r.calls += 1;
      for (const [kind, n] of Object.entries(obj(d["tokensByKind"])))
        r.tokensByKind[kind] = (r.tokensByKind[kind] ?? 0) + num(n);
      for (const red of Array.isArray(d["reductions"]) ? (d["reductions"] as unknown[]) : []) {
        const action = obj(red)["action"];
        if (typeof action === "string") r.reductions[action] = (r.reductions[action] ?? 0) + 1;
      }
    } else if (e.event === "context.compacted") {
      const r = row(role, lastModel.get(role) ?? "unknown");
      const n = Array.isArray(d["reductions"]) ? d["reductions"].length : 0;
      r.reductions["compacted"] = (r.reductions["compacted"] ?? 0) + n;
    } else if (e.event === "context.read") row(role, lastModel.get(role) ?? "unknown").reads += 1;
    else if (e.event === "context.search") row(role, lastModel.get(role) ?? "unknown").searches += 1;
    else if (e.event === "model.usage") {
      const r = row(
        typeof d["role"] === "string" ? d["role"] : role,
        typeof d["model"] === "string" ? d["model"] : "unknown",
      );
      r.inputTokens += num(d["inputTokens"]);
      r.cachedInputTokens += num(d["cachedInputTokens"]);
    }
  }
  return [...rows.values()].sort((a, b) => (a.role + a.model < b.role + b.model ? -1 : 1));
}

/**
 * Adds up the context usage of several runs per role and model (REQ-CTX-18/AC1).
 *
 * @param runs - The usage of each run.
 */
export function mergeContextUsage(runs: readonly (readonly ContextUsage[])[]): ContextUsage[] {
  const out = new Map<string, Mutable>();
  for (const rows of runs)
    for (const r of rows) {
      const key = `${r.role}\u0000${r.model}`;
      const m = out.get(key);
      if (!m) {
        out.set(key, { ...r, tokensByKind: { ...r.tokensByKind }, reductions: { ...r.reductions } });
        continue;
      }
      m.calls += r.calls;
      m.reads += r.reads;
      m.searches += r.searches;
      m.inputTokens += r.inputTokens;
      m.cachedInputTokens += r.cachedInputTokens;
      for (const [k, n] of Object.entries(r.tokensByKind)) m.tokensByKind[k] = (m.tokensByKind[k] ?? 0) + n;
      for (const [k, n] of Object.entries(r.reductions)) m.reductions[k] = (m.reductions[k] ?? 0) + n;
    }
  return [...out.values()].sort((a, b) => (a.role + a.model < b.role + b.model ? -1 : 1));
}
