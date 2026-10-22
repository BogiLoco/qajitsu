import { describe, expect, it } from "vitest";
import { sha256 } from "../plan/plan-store.js";
import { checkTranscript, createTranscript } from "./transcript.js";

const usageLine = (exchangeSha256?: string): string =>
  JSON.stringify({
    ts: "t",
    run: "r",
    ticket: "DEMO-1",
    stage: "plan",
    actor: { kind: "agent", name: "planner" },
    event: "model.usage",
    details: { role: "planner", ...(exchangeSha256 ? { exchangeSha256 } : {}) },
  });

describe("agent transcript (REQ-VER-16)", () => {
  const exchange = {
    stage: "plan",
    role: "planner",
    model: "local/qwen3:14b",
    request: { system: "You plan tests.", messages: [{ role: "user", content: "password hunter2 here" }] },
    response: { text: '{"cases":[]}', steps: [] },
    usage: { inputTokens: 10, outputTokens: 5 },
  };

  it("REQ-VER-16/AC2+AC3: every model exchange is stored masked, and its hash covers exactly the stored line", () => {
    const lines: string[] = [];
    const record = createTranscript({
      write: (l) => lines.push(l),
      mask: (v) => JSON.parse(JSON.stringify(v).replaceAll("hunter2", "***")) as unknown,
      now: () => new Date(0),
    });
    const first = record(exchange);
    const second = record({ ...exchange, role: "analyst" });
    expect(lines).toHaveLength(2);
    expect(lines.join("")).not.toContain("hunter2");
    expect(lines[0]).toContain("password *** here");
    expect(first.sha256).toBe(sha256((lines[0] ?? "").trimEnd()));
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
      seq: 2,
      role: "analyst",
      ts: new Date(0).toISOString(),
    });
    expect(second.seq).toBe(2);
  });

  it("REQ-VER-16/AC4: the journal and the transcript must match: a missing, changed or unrecorded exchange is a gap", () => {
    const lines: string[] = [];
    const record = createTranscript({ write: (l) => lines.push(l), mask: (v) => v, now: () => new Date(0) });
    const a = record(exchange);
    const b = record(exchange);
    const transcript = lines.join("");
    const events = [usageLine(a.sha256), usageLine(b.sha256)].join("\n");
    expect(checkTranscript(events, transcript)).toEqual([]);

    // A changed line no longer has the hash the journal recorded.
    const changed = transcript.replace('"stage":"plan"', '"stage":"fake"');
    expect(checkTranscript(events, changed)).toEqual([
      `journal line 1: model exchange ${a.sha256.slice(0, 12)} is not in journal/agents.jsonl`,
      "journal/agents.jsonl line 1: not referenced by the journal",
    ]);
    // A removed transcript.
    expect(checkTranscript(events, undefined)).toEqual(["journal/agents.jsonl is missing (2 model calls)"]);
    // A model call recorded before prompts and answers were kept.
    expect(checkTranscript(usageLine(), "")).toEqual([
      "journal line 1: model call without a recorded prompt and answer",
    ]);
    // A run without model calls needs no transcript.
    expect(checkTranscript("", undefined)).toEqual([]);
  });
});
