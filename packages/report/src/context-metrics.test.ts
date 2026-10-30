import { createEventLog, parseEventLines, type RunEvent } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { contextUsage, mergeContextUsage } from "./context-metrics.js";

const journal = (write: (log: ReturnType<typeof createEventLog>) => void): RunEvent[] => {
  const lines: string[] = [];
  const log = createEventLog({
    ticket: "DEMO-1",
    run: "r",
    write: (l) => lines.push(l),
    now: () => new Date(0),
    mask: (v) => v,
  });
  write(log);
  return parseEventLines(lines.join("")).events;
};

const planner = { kind: "agent", name: "planner" } as const;

describe("context metrics (REQ-CTX-18/AC1)", () => {
  it("REQ-CTX-18/AC1: tokens by source, reductions, catalogue reads and cache hits per role and model", () => {
    const events = journal((log) => {
      log.emit("plan", planner, "context.snapshot", {
        role: "planner",
        model: "claude/c",
        tokensByKind: { ticket: 300, diff: 2_000 },
        reductions: [
          { sha256: "a", action: "handle", reason: "r", tokensSaved: 1 },
          { sha256: "b", action: "trimmed", reason: "r", tokensSaved: 1 },
        ],
      });
      log.emit("plan", planner, "context.read", { handle: "h-1", found: true });
      log.emit("plan", planner, "context.search", { hits: 1 });
      log.emit("plan", planner, "context.compacted", { reductions: [{}, {}] });
      log.emit("plan", planner, "model.usage", {
        role: "planner",
        model: "claude/c",
        inputTokens: 1_000,
        cachedInputTokens: 600,
      });
      log.emit("plan", planner, "context.snapshot", {
        role: "planner",
        model: "claude/c",
        tokensByKind: { diff: 500 },
        reductions: [],
      });
    });
    expect(contextUsage(events)).toEqual([
      {
        role: "planner",
        model: "claude/c",
        calls: 2,
        tokensByKind: { ticket: 300, diff: 2_500 },
        reductions: { handle: 1, trimmed: 1, compacted: 2 },
        reads: 1,
        searches: 1,
        inputTokens: 1_000,
        cachedInputTokens: 600,
      },
    ]);
    const merged = mergeContextUsage([contextUsage(events), contextUsage(events)]);
    expect(merged[0]).toMatchObject({
      calls: 4,
      reads: 2,
      tokensByKind: { diff: 5_000 },
      reductions: { compacted: 4 },
    });
  });
});
