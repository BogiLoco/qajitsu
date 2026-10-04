import { createHash } from "node:crypto";
import type { RunEvent } from "../events/event-log.js";

/** OTLP/JSON request bodies for `/v1/traces`, `/v1/logs` and `/v1/metrics` (REQ-OBS-03). */
export interface OtlpPayloads {
  readonly traces: unknown;
  readonly logs: unknown;
  readonly metrics: unknown;
  /** Spans and log records in this batch, for reporting. */
  readonly counts: { readonly spans: number; readonly logs: number; readonly metrics: number };
}

type Value = string | number | boolean;
const kv = (key: string, value: Value) => ({
  key,
  value:
    typeof value === "boolean"
      ? { boolValue: value }
      : typeof value === "number"
        ? Number.isInteger(value)
          ? { intValue: String(value) }
          : { doubleValue: value }
        : { stringValue: value },
});
const attrs = (o: Record<string, Value | undefined>) =>
  Object.entries(o)
    .filter((e): e is [string, Value] => e[1] !== undefined)
    .map(([k, v]) => kv(k, v));
const hash = (s: string, length: number): string =>
  createHash("sha256").update(s).digest("hex").slice(0, length);
const nanos = (ts: string): string => `${String(Date.parse(ts))}000000`;
const detail = (e: RunEvent, key: string): unknown =>
  (e.details as Record<string, unknown> | undefined)?.[key];
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Detail fields exported by default: identifiers, codes, counts and statuses. Tool arguments and results,
 * error texts, ticket and plan content stay on the machine unless `includeDetails` is set.
 */
export const TELEMETRY_DETAIL_FIELDS: readonly string[] = [
  "tool",
  "code",
  "role",
  "model",
  "inputTokens",
  "outputTokens",
  "costUsd",
  "runTotalTokens",
  "caseId",
  "attempt",
  "outcome",
  "statuses",
  "gatesOk",
  "ok",
  "cases",
  "env",
  "status",
  "caught",
  "version",
  "planVersion",
  "attempts",
  "confidence",
  "openQuestions",
  "kept",
  "healed",
  "weak",
  "mode",
  "step",
  "field",
];
const pick = (details: unknown, full: boolean): unknown => {
  if (full) return details;
  if (details === null || typeof details !== "object") return undefined;
  const kept = Object.entries(details as Record<string, unknown>).filter(([k]) =>
    TELEMETRY_DETAIL_FIELDS.includes(k),
  );
  return kept.length === 0 ? undefined : Object.fromEntries(kept);
};
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

interface Span {
  key: string;
  parent?: string;
  name: string;
  start: string;
  end: string;
  endIndex: number;
  error?: string;
  attributes: Record<string, Value | undefined>;
}

/**
 * Turns a run journal into OTLP traces, logs and metrics (REQ-OBS-03/AC1): the run is a trace, every
 * stage a span, tool calls, model calls and case attempts are child spans of their stage. Ids are derived
 * from run id and position, so re-exporting the same events yields the same ids. Only spans and log records
 * that end at or after `fromIndex` are included, which makes exports incremental; the run span is always sent.
 *
 * @param events - Parsed `events.jsonl` (already masked).
 * @param options - Service name and the index of the first event not exported yet.
 */
export function buildOtlp(
  events: readonly RunEvent[],
  options: {
    readonly serviceName: string;
    readonly serviceVersion?: string;
    readonly fromIndex?: number;
    /** Send full event details (tool arguments and results, error texts); default: allowlisted fields only. */
    readonly includeDetails?: boolean;
  },
): OtlpPayloads {
  const full = options.includeDetails === true;
  const from = options.fromIndex ?? 0;
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last)
    return {
      traces: { resourceSpans: [] },
      logs: { resourceLogs: [] },
      metrics: { resourceMetrics: [] },
      counts: { spans: 0, logs: 0, metrics: 0 },
    };
  const run = first.run;
  const traceId = hash(`trace:${run}`, 32);
  const spanId = (key: string): string => hash(`${run}:${key}`, 16);
  const spans: Span[] = [
    {
      key: "run",
      name: `qajitsu ${first.ticket}`,
      start: first.ts,
      end: last.ts,
      endIndex: events.length - 1,
      attributes: { "qajitsu.ticket": first.ticket, "qajitsu.run": run },
    },
  ];
  const openStage = new Map<string, Span>();
  const stageCount = new Map<string, number>();
  const openTool = new Map<string, Span>();
  const openAttempt = new Map<string, Span>();
  const stageOf = (e: RunEvent): Span => {
    let span = openStage.get(e.stage);
    if (!span) {
      const n = (stageCount.get(e.stage) ?? 0) + 1;
      stageCount.set(e.stage, n);
      span = {
        key: `stage:${e.stage}:${String(n)}`,
        parent: "run",
        name: `stage ${e.stage}`,
        start: e.ts,
        end: e.ts,
        endIndex: -1,
        attributes: { "qajitsu.stage": e.stage },
      };
      openStage.set(e.stage, span);
      spans.push(span);
    }
    return span;
  };
  events.forEach((e, i) => {
    const stage = stageOf(e);
    stage.end = e.ts;
    stage.endIndex = i;
    const actorAttrs = { "qajitsu.actor": `${e.actor.kind}:${e.actor.name}` };
    if (e.event === "stage.end") openStage.delete(e.stage);
    const stageError = str(detail(e, "error"));
    if (stageError !== undefined && e.event.endsWith(".error")) stage.error = full ? stageError : e.event;
    if (e.event === "tool_allowed" || e.event === "tool_denied") {
      const tool = str(detail(e, "tool")) ?? "tool";
      const span: Span = {
        key: `tool:${String(i)}`,
        parent: stage.key,
        name: `tool ${tool}`,
        start: e.ts,
        end: e.ts,
        endIndex: i,
        attributes: { ...actorAttrs, "qajitsu.tool": tool, "qajitsu.guard.code": str(detail(e, "code")) },
        ...(e.event === "tool_denied"
          ? {
              error: full
                ? (str(detail(e, "reason")) ?? "denied by the guard")
                : `denied: ${str(detail(e, "code")) ?? "guard"}`,
            }
          : {}),
      };
      spans.push(span);
      if (e.event === "tool_allowed") openTool.set(`${e.actor.name}:${tool}`, span);
    }
    if (e.event === "tool_result") {
      const span = openTool.get(`${e.actor.name}:${str(detail(e, "tool")) ?? "tool"}`);
      if (span) {
        span.end = e.ts;
        span.endIndex = i;
      }
    }
    if (e.event === "model.usage") {
      spans.push({
        key: `model:${String(i)}`,
        parent: stage.key,
        name: `gen_ai ${str(detail(e, "role")) ?? e.actor.name}`,
        start: e.ts,
        end: e.ts,
        endIndex: i,
        // OpenTelemetry GenAI conventions, so Langfuse and similar tools pick up prompts and costs.
        attributes: {
          "gen_ai.request.model": str(detail(e, "model")),
          "gen_ai.usage.input_tokens": num(detail(e, "inputTokens")),
          "gen_ai.usage.output_tokens": num(detail(e, "outputTokens")),
          "qajitsu.cost_usd": num(detail(e, "costUsd")),
          "qajitsu.role": str(detail(e, "role")),
        },
      });
    }
    const caseId = str(detail(e, "caseId"));
    const attempt = num(detail(e, "attempt"));
    if (e.event === "case.attempt.start" && caseId && attempt !== undefined) {
      const span: Span = {
        key: `case:${caseId}:${String(attempt)}:${String(i)}`,
        parent: stage.key,
        name: `case ${caseId} attempt ${String(attempt)}`,
        start: e.ts,
        end: e.ts,
        endIndex: i,
        attributes: { "qajitsu.case": caseId, "qajitsu.attempt": attempt },
      };
      openAttempt.set(`${caseId}:${String(attempt)}`, span);
      spans.push(span);
    }
    if (e.event === "case.attempt.end" && caseId && attempt !== undefined) {
      const span = openAttempt.get(`${caseId}:${String(attempt)}`);
      if (span) {
        span.end = e.ts;
        span.endIndex = i;
        span.attributes["qajitsu.outcome"] = str(detail(e, "outcome"));
        if (str(detail(e, "outcome")) === "error")
          span.error = full ? (str(detail(e, "error")) ?? "attempt error") : "attempt error";
      }
    }
  });
  const exported = spans.filter((s) => s.key === "run" || s.endIndex >= from);
  const resource = {
    attributes: attrs({ "service.name": options.serviceName, "service.version": options.serviceVersion }),
  };
  const scope = { name: "qajitsu", version: options.serviceVersion ?? "0" };
  const traces = {
    resourceSpans: [
      {
        resource,
        scopeSpans: [
          {
            scope,
            spans: exported.map((s) => ({
              traceId,
              spanId: spanId(s.key),
              ...(s.parent ? { parentSpanId: spanId(s.parent) } : {}),
              name: s.name,
              kind: 1,
              startTimeUnixNano: nanos(s.start),
              endTimeUnixNano: nanos(s.end),
              attributes: attrs(s.attributes),
              status: s.error === undefined ? { code: 1 } : { code: 2, message: s.error.slice(0, 500) },
            })),
          },
        ],
      },
    ],
  };
  const stageSpanAt = new Map<number, string>();
  for (const s of spans.filter((x) => x.key.startsWith("stage:"))) stageSpanAt.set(s.endIndex, s.key);
  const records = events.slice(from).map((e) => {
    const warn = /denied|failed|error|mismatch|exceeded|blocked/.test(e.event);
    return {
      timeUnixNano: nanos(e.ts),
      severityNumber: warn ? 13 : 9,
      severityText: warn ? "WARN" : "INFO",
      body: { stringValue: e.event },
      attributes: attrs({
        "qajitsu.stage": e.stage,
        "qajitsu.actor": `${e.actor.kind}:${e.actor.name}`,
        "qajitsu.ticket": e.ticket,
        "qajitsu.run": e.run,
        "qajitsu.details": ((d: unknown) => (d === undefined ? undefined : JSON.stringify(d).slice(0, 4000)))(
          pick(e.details, full),
        ),
      }),
      traceId,
      spanId: spanId(`stage:${e.stage}:${String(stageCount.get(e.stage) ?? 1)}`),
    };
  });
  const logs = { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: records }] }] };
  // Metrics of this batch: tokens and cost as monotonic sums, final case statuses as a gauge.
  const batch = events.slice(from);
  const time = nanos(last.ts);
  const runAttrs = attrs({ "qajitsu.ticket": first.ticket, "qajitsu.run": run });
  const usage = batch.filter((e) => e.event === "model.usage");
  const tokens = usage.reduce(
    (n, e) => n + (num(detail(e, "inputTokens")) ?? 0) + (num(detail(e, "outputTokens")) ?? 0),
    0,
  );
  const cost = usage.reduce((n, e) => n + (num(detail(e, "costUsd")) ?? 0), 0);
  const runEnd = batch.filter((e) => e.stage === "run" && e.event === "stage.end").at(-1);
  const statuses = (detail(runEnd ?? first, "statuses") ?? {}) as Record<string, string>;
  const byStatus = Object.values(statuses).reduce<Record<string, number>>(
    (acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }),
    {},
  );
  const denied = batch.filter((e) => e.event === "tool_denied").length;
  const sum = (name: string, unit: string, value: number) => ({
    name,
    unit,
    sum: {
      aggregationTemporality: 1,
      isMonotonic: true,
      dataPoints: [{ attributes: runAttrs, timeUnixNano: time, asDouble: value }],
    },
  });
  const metricList = [
    ...(usage.length > 0
      ? [sum("qajitsu.model.tokens", "{token}", tokens), sum("qajitsu.model.cost", "USD", cost)]
      : []),
    ...(denied > 0 ? [sum("qajitsu.guard.denied", "{call}", denied)] : []),
    ...(runEnd
      ? [
          {
            name: "qajitsu.cases",
            unit: "{case}",
            gauge: {
              dataPoints: Object.entries(byStatus).map(([status, n]) => ({
                attributes: [...runAttrs, kv("qajitsu.status", status)],
                timeUnixNano: time,
                asInt: String(n),
              })),
            },
          },
        ]
      : []),
  ];
  const metrics = { resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics: metricList }] }] };
  return {
    traces,
    logs,
    metrics,
    counts: { spans: exported.length, logs: records.length, metrics: metricList.length },
  };
}
