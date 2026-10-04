import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events/event-log.js";
import { buildOtlp } from "./otlp.js";

const ev = (
  i: number,
  stage: string,
  event: string,
  details?: Record<string, unknown>,
  actor = { kind: "system", name: "orchestrator" },
): RunEvent =>
  ({
    ts: new Date(Date.UTC(2026, 9, 4, 10, 0, i)).toISOString(),
    run: "20261004-1000-aaaa",
    ticket: "DEMO-1",
    stage,
    actor,
    event,
    ...(details ? { details } : {}),
  }) as RunEvent;

const events: RunEvent[] = [
  ev(0, "plan", "stage.start"),
  ev(1, "plan", "tool_allowed", { tool: "read_file" }, { kind: "agent", name: "planner" }),
  ev(2, "plan", "tool_result", { tool: "read_file" }, { kind: "agent", name: "planner" }),
  ev(
    3,
    "plan",
    "tool_denied",
    { tool: "write_file", code: "PROTECTED_PATH", reason: "results/ is protected" },
    { kind: "agent", name: "planner" },
  ),
  ev(
    4,
    "plan",
    "model.usage",
    { role: "planner", model: "local/gemma4:e2b", inputTokens: 100, outputTokens: 20, costUsd: 0.5 },
    { kind: "agent", name: "planner" },
  ),
  ev(5, "plan", "stage.end"),
  ev(6, "run", "stage.start"),
  ev(7, "run", "case.attempt.start", { caseId: "TC-01", attempt: 1 }),
  ev(9, "run", "case.attempt.end", { caseId: "TC-01", attempt: 1, outcome: "error", error: "timeout" }),
  ev(10, "run", "stage.end", { statuses: { "TC-01": "BLOCKED", "TC-02": "PASSED" } }),
];

interface Span {
  name: string;
  spanId: string;
  parentSpanId?: string;
  traceId: string;
  status: { code: number; message?: string };
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: Record<string, unknown> }[];
}
const spansOf = (p: ReturnType<typeof buildOtlp>) =>
  (p.traces as { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] }).resourceSpans[0]?.scopeSpans[0]
    ?.spans ?? [];
const attr = (s: Span, key: string) => s.attributes.find((a) => a.key === key)?.value;

describe("OTLP export (REQ-OBS-03)", () => {
  it("REQ-OBS-03/AC1: run = trace, stage = span, tool and model calls and case attempts = child spans; logs and metrics", () => {
    const p = buildOtlp(events, { serviceName: "qajitsu", serviceVersion: "1.0.0" });
    const spans = spansOf(p);
    expect(spans.map((s) => s.name)).toEqual([
      "qajitsu DEMO-1",
      "stage plan",
      "tool read_file",
      "tool write_file",
      "gen_ai planner",
      "stage run",
      "case TC-01 attempt 1",
    ]);
    const [root, plan, read, write, model, run, attempt] = spans as [
      Span,
      Span,
      Span,
      Span,
      Span,
      Span,
      Span,
    ];
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);
    expect(root.parentSpanId).toBeUndefined();
    expect([plan.parentSpanId, run.parentSpanId]).toEqual([root.spanId, root.spanId]);
    expect([read.parentSpanId, write.parentSpanId, model.parentSpanId]).toEqual([
      plan.spanId,
      plan.spanId,
      plan.spanId,
    ]);
    expect(attempt.parentSpanId).toBe(run.spanId);
    expect(read.endTimeUnixNano > read.startTimeUnixNano).toBe(true);
    // By default only codes leave the machine, not guard reasons or error texts.
    expect(write.status).toEqual({ code: 2, message: "denied: PROTECTED_PATH" });
    expect(attempt.status).toEqual({ code: 2, message: "attempt error" });
    expect(attr(model, "gen_ai.usage.input_tokens")).toEqual({ intValue: "100" });
    expect(attr(model, "qajitsu.cost_usd")).toEqual({ doubleValue: 0.5 });
    expect(p.counts).toEqual({ spans: 7, logs: 10, metrics: 4 });
    const logs =
      (
        p.logs as {
          resourceLogs: {
            scopeLogs: { logRecords: { severityText: string; body: { stringValue: string } }[] }[];
          }[];
        }
      ).resourceLogs[0]?.scopeLogs[0]?.logRecords ?? [];
    expect(logs.find((l) => l.body.stringValue === "tool_denied")?.severityText).toBe("WARN");
    const metrics =
      (
        p.metrics as {
          resourceMetrics: {
            scopeMetrics: {
              metrics: {
                name: string;
                gauge?: {
                  dataPoints: {
                    asInt: string;
                    attributes: { key: string; value: { stringValue?: string } }[];
                  }[];
                };
              }[];
            }[];
          }[];
        }
      ).resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [];
    expect(metrics.map((m) => m.name)).toEqual([
      "qajitsu.model.tokens",
      "qajitsu.model.cost",
      "qajitsu.guard.denied",
      "qajitsu.cases",
    ]);
    expect(
      metrics[3]?.gauge?.dataPoints.map((d) => [d.attributes.at(-1)?.value.stringValue, d.asInt]),
    ).toEqual([
      ["BLOCKED", "1"],
      ["PASSED", "1"],
    ]);
  });

  it("stage-9 review: tool arguments and results stay local unless include_details is set", () => {
    const withArgs = [
      ...events,
      ev(
        11,
        "run",
        "tool_allowed",
        { tool: "write_file", args: { content: "customer data 4111-1111" } },
        { kind: "agent", name: "author" },
      ),
    ];
    const lean = JSON.stringify(buildOtlp(withArgs, { serviceName: "q" }));
    expect(lean).not.toContain("customer data");
    expect(lean).not.toContain("results/ is protected");
    expect(lean).toContain('\\"tool\\":\\"write_file\\"');
    const full = buildOtlp(withArgs, { serviceName: "q", includeDetails: true });
    expect(JSON.stringify(full)).toContain("customer data");
    expect(spansOf(full).find((s) => s.name === "tool write_file")?.status).toEqual({
      code: 2,
      message: "results/ is protected",
    });
  });

  it("REQ-OBS-03: exports are incremental with stable ids; empty journals export nothing", () => {
    const all = spansOf(buildOtlp(events, { serviceName: "q" }));
    const later = buildOtlp(events, { serviceName: "q", fromIndex: 6 });
    expect(spansOf(later).map((s) => s.name)).toEqual([
      "qajitsu DEMO-1",
      "stage run",
      "case TC-01 attempt 1",
    ]);
    expect(spansOf(later).map((s) => s.spanId)).toEqual([all[0]?.spanId, all[5]?.spanId, all[6]?.spanId]);
    expect(later.counts).toEqual({ spans: 3, logs: 4, metrics: 1 });
    expect(buildOtlp([], { serviceName: "q" }).counts).toEqual({ spans: 0, logs: 0, metrics: 0 });
  });
});
