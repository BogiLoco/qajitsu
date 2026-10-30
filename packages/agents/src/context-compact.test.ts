import { createEventLog, fragment, parseEventLines } from "@qajitsu/core";
import { DEFAULT_PROTECTED_PATHS, createGuard, createJournal } from "@qajitsu/guard";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { promptOf, scriptedModel } from "../../../tests/support/mock-model.js";
import { compactMessages, messagesTokens } from "./context-compact.js";
import { runStructuredAgent, type AgentTool } from "./loop.js";
import { assembleFor, type AgentStageDeps } from "./roles-run.js";
import { createUsageTracker } from "./usage.js";

const big = (n: number): string => `content of file ${String(n)}\n${"x".repeat(2_000)}`;

/** A loop of `n` read_file calls, each with its result, after the first message. */
const loop = (n: number, latest = ""): ModelMessage[] => [
  { role: "user", content: `the assembled input ${"y".repeat(3_000)}` },
  ...Array.from({ length: n }, (_, i): ModelMessage[] => [
    {
      role: "assistant",
      content: [
        ...(i === n - 1 && latest ? [{ type: "text" as const, text: latest }] : []),
        {
          type: "tool-call",
          toolCallId: `c${String(i)}`,
          toolName: "read_file",
          input: { path: `src/f${String(i)}.ts` },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `c${String(i)}`,
          toolName: "read_file",
          output: { type: "text", value: big(i) },
        },
      ],
    },
  ]).flat(),
];

const outputs = (ms: readonly ModelMessage[]): string[] =>
  ms.flatMap((m) =>
    m.role === "tool"
      ? m.content.flatMap((p) =>
          p.type === "tool-result" && p.output.type === "text" ? [p.output.value] : [],
        )
      : [],
  );

describe("compaction of long agent loops (REQ-CTX-16)", () => {
  it("REQ-CTX-16/AC1: a loop that fits its budget is never compacted, however many turns it has", () => {
    const ms = loop(8);
    expect(compactMessages(ms, { system: "s", budget: messagesTokens("s", ms), margin: 1 })).toBeUndefined();
  });

  it("REQ-CTX-16/AC2+AC3: the oldest results go behind handles with a line by code; the last ones and the first message stay", () => {
    const ms = loop(5);
    const kept: string[] = [];
    const done = compactMessages(ms, {
      system: "s",
      budget: messagesTokens("s", ms) - 300,
      margin: 1,
      keep: (_, text) => (kept.push(text), `h-0000000${String(kept.length)}`),
    });
    const texts = outputs(done?.messages ?? []);
    expect(texts[0]).toBe(
      "[compacted by QAJitsu: read_file(src/f0.ts) returned 2018 characters, left out to fit the budget; the full result is h-00000001, read it with read_context]",
    );
    // Only as many as needed: the second oldest is already whole again.
    expect(texts.slice(1)).toEqual([big(1), big(2), big(3), big(4)]);
    expect(kept).toEqual([big(0)]);
    expect(done?.messages[0]).toEqual(ms[0]);
    expect(done?.compactions).toEqual([
      expect.objectContaining({ action: "compacted", tokensSaved: expect.any(Number) as unknown }),
    ]);
    // The input is never changed in place.
    expect(outputs(ms)[0]).toBe(big(0));
    // The last two results stay whole even when the loop is still over its budget.
    const tight = compactMessages(ms, { system: "s", budget: 1, margin: 1 });
    expect(outputs(tight?.messages ?? []).slice(-2)).toEqual([big(3), big(4)]);
    expect(outputs(tight?.messages ?? [])[0]).toContain("call the tool again if you need it");
  });

  it("REQ-CTX-16/AC2: a result the latest turn still refers to stays whole", () => {
    const ms = loop(5, "As src/f0.ts showed, the total is rounded once.");
    const done = compactMessages(ms, { system: "s", budget: 1, margin: 1 });
    expect(outputs(done?.messages ?? [])).toEqual([
      big(0),
      expect.stringContaining("[compacted"),
      expect.stringContaining("[compacted"),
      big(3),
      big(4),
    ]);
  });

  it("REQ-CTX-16/AC1+AC2+AC3: in a tool loop the step that would not fit is compacted, journaled and readable again", async () => {
    const lines: string[] = [];
    const events = createEventLog({
      ticket: "DEMO-1",
      run: "r",
      write: (l) => lines.push(l),
      now: () => new Date(0),
      mask: (v) => v,
    });
    const deps = { events } as unknown as AgentStageDeps;
    const model = scriptedModel([
      { tools: [{ name: "read_file", input: { path: "src/f0.ts" } }] },
      { tools: [{ name: "read_file", input: { path: "src/f1.ts" } }] },
      { tools: [{ name: "read_file", input: { path: "src/f2.ts" } }] },
      { tools: [{ name: "read_file", input: { path: "src/f3.ts" } }] },
      { text: '{"answer": 1}' },
    ]);
    // A 2,000-token budget: the four results (about 500 tokens each) do not fit together.
    const budgeted = { ...model, context: { ...model.context, workingRange: 6_000, answerReserve: 4_000 } };
    const context = await assembleFor(deps, {
      stage: "analyze",
      role: "probe-test",
      model: budgeted,
      fragments: [
        fragment({
          kind: "role-instructions",
          source: "probe-test",
          trust: "trusted",
          section: "stable",
          priority: 100,
          pinned: true,
          text: "Read files.",
        }),
        fragment({
          kind: "question",
          source: "question",
          trust: "trusted",
          section: "varying",
          priority: 0,
          pinned: true,
          text: "Answer.",
        }),
      ],
    });
    const read: AgentTool = {
      name: "read_file",
      description: "read",
      inputSchema: z.object({ path: z.string() }),
      execute: (i) => Promise.resolve(big(Number(String(i["path"]).replace(/\D/g, "")))),
    };
    const guard = createGuard({
      run: "r",
      stage: "analyze",
      policy: {
        workspaceRoot: "/runs/r",
        allowedTools: new Set(["read_file", "read_context", "search_context"]),
        writeTools: new Set(),
        protectedPaths: DEFAULT_PROTECTED_PATHS,
        networkTools: new Set(),
        allowedOrigins: [],
      },
      journal: createJournal(
        () => undefined,
        () => new Date(0),
        (v) => v,
      ),
    });
    const { value } = await runStructuredAgent({
      stage: "analyze",
      role: "probe-test",
      model: budgeted,
      context,
      schema: z.object({ answer: z.number() }),
      tools: [read],
      guard,
      usage: createUsageTracker({ events }),
    });
    expect(value).toEqual({ answer: 1 });
    // Steps 1-3 fit; before step 5 the oldest result is compacted, never the input or the latest results.
    expect(promptOf(model, 3)).not.toContain("[compacted by QAJitsu");
    const last = promptOf(model, 4);
    expect(last).toContain("[compacted by QAJitsu: read_file(src/f0.ts)");
    expect(last).toContain("content of file 3");
    const compacted = parseEventLines(lines.join("")).events.filter((e) => e.event === "context.compacted");
    expect(compacted.length).toBeGreaterThan(0);
    const handle = /the full result is (h-[0-9a-f]{8})/.exec(last)?.[1] ?? "";
    const readContext = context.tools?.find((t) => t.name === "read_context");
    expect(await readContext?.execute({ handle })).toContain("content of file 0");
  });
});
