import { createEventLog, parseEventLines } from "@qajitsu/core";
import { DEFAULT_PROTECTED_PATHS, createGuard, createJournal } from "@qajitsu/guard";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { promptOf, scriptedModel } from "../../../tests/support/mock-model.js";
import { decodingSchema, extractJson, runStructuredAgent, type AgentTool } from "./loop.js";
import { createUsageTracker } from "./usage.js";

const now = (): Date => new Date("2026-10-03T12:00:00Z");
const setup = (budget?: number) => {
  const lines: string[] = [];
  const events = createEventLog({
    ticket: "DEMO-1",
    run: "r",
    write: (l) => lines.push(l),
    now,
    mask: (v) => v,
  });
  const journal: string[] = [];
  const guard = createGuard({
    run: "r",
    stage: "analyze",
    policy: {
      workspaceRoot: "/runs/r",
      allowedTools: new Set(["read_file"]),
      writeTools: new Set(["write_file"]),
      protectedPaths: DEFAULT_PROTECTED_PATHS,
      networkTools: new Set(),
      allowedOrigins: [],
    },
    journal: createJournal(
      (l) => journal.push(l),
      now,
      (v) => v,
    ),
  });
  const usage = createUsageTracker({ events, budget });
  return {
    lines,
    events,
    guard,
    journal,
    usage,
    eventNames: () => parseEventLines(lines.join("")).events.map((e) => e.event),
  };
};

const Answer = z.object({ answer: z.number() });
const executed: string[] = [];
const tools: AgentTool[] = [
  {
    name: "read_file",
    description: "read",
    inputSchema: z.object({ path: z.string() }),
    execute: (i) => (executed.push(String(i["path"])), Promise.resolve("file content")),
  },
  {
    name: "write_file",
    description: "write",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: (i) => (executed.push(`write:${String(i["path"])}`), Promise.resolve("written")),
  },
];

describe("structured agent loop (REQ-LLM-04, REQ-VER-03/AC3)", () => {
  it("REQ-VER-03/AC3: every tool call goes through the guard; denied calls never execute", async () => {
    executed.length = 0;
    const { guard, journal, usage } = setup();
    const model = scriptedModel([
      {
        tools: [
          { name: "read_file", input: { path: "repos/web/a.ts" } },
          { name: "write_file", input: { path: "results/TC-01.json", content: "PASSED" } },
        ],
      },
      { text: '{"answer": 42}' },
    ]);
    const { value } = await runStructuredAgent({
      stage: "analyze",
      role: "analyst",
      model,
      system: "s",
      prompt: "p",
      schema: Answer,
      tools,
      guard,
      usage,
    });
    expect(value).toEqual({ answer: 42 });
    expect(executed).toEqual(["repos/web/a.ts"]);
    expect(promptOf(model, 1)).toContain("DENIED (UNKNOWN_TOOL)");
    const decisions = journal.map((l) => (JSON.parse(l) as { event: string }).event);
    // Tool calls of one step run in parallel, so only the set of decisions is deterministic.
    expect([...decisions].sort()).toEqual(["tool_allowed", "tool_denied", "tool_result"]);
  });

  it("REQ-LLM-04/AC1+AC2: invalid output is returned with the validation errors and repaired", async () => {
    const { guard, usage } = setup();
    const model = scriptedModel(
      [{ text: "I think 42" }, { text: '```json\n{"answer": "42"}\n```' }, { text: '{"answer": 42}' }],
      {
        structuredOutput: false,
      },
    );
    const result = await runStructuredAgent({
      stage: "s",
      role: "analyst",
      model,
      system: "s",
      prompt: "p",
      schema: Answer,
      guard,
      usage,
    });
    expect(result).toEqual({ value: { answer: 42 }, attempts: 3 });
    expect(promptOf(model, 1)).toContain("not valid JSON");
    expect(promptOf(model, 2)).toContain("answer: Invalid input");
  });

  it("REQ-LLM-04/AC2: after 3 invalid answers the stage fails instead of guessing", async () => {
    const { usage } = setup();
    const model = scriptedModel([{ text: '{"answer": 1}' }]);
    await expect(
      runStructuredAgent({
        stage: "s",
        role: "planner",
        model,
        system: "s",
        prompt: "p",
        schema: Answer,
        usage,
        validate: (v) => (v.answer === 42 ? [] : ["answer must be grounded"]),
      }),
    ).rejects.toMatchObject({
      name: "AgentOutputError",
      code: "AGENT_OUTPUT_INVALID",
      context: { errors: ["answer must be grounded"] },
    });
    expect(model.mock.doGenerateCalls).toHaveLength(3);
  });

  it("REQ-LLM-04/AC3: models without tools get no tools and still answer in JSON mode", async () => {
    const { guard, usage } = setup();
    const model = scriptedModel([{ text: '{"answer": 7}' }], { tools: false, structuredOutput: false });
    await runStructuredAgent({
      stage: "s",
      role: "analyst",
      model,
      system: "s",
      prompt: "p",
      schema: Answer,
      tools,
      guard,
      usage,
    });
    expect(model.mock.doGenerateCalls[0]?.tools).toBeUndefined();
  });

  it("REQ-LLM-07/AC1: tokens and cost per call, role and model are journaled", async () => {
    const { usage, lines } = setup();
    const model = scriptedModel([{ text: '{"answer": 1}' }], { costPerMTok: { input: 3, output: 15 } });
    await runStructuredAgent({
      stage: "plan",
      role: "planner",
      model,
      system: "s",
      prompt: "p",
      schema: Answer,
      usage,
    });
    const event = parseEventLines(lines.join("")).events.find((e) => e.event === "model.usage");
    expect(event).toMatchObject({
      stage: "plan",
      actor: { kind: "agent", name: "planner" },
      details: {
        model: "mock/scripted",
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.0006,
        runTotalTokens: 120,
      },
    });
    expect(usage.costUsd).toBeCloseTo(0.0006);
  });

  it("REQ-LLM-07/AC2: exceeding the token budget stops the run", async () => {
    const { usage, eventNames } = setup(150);
    const model = scriptedModel([{ text: "nope" }, { text: '{"answer": 1}' }]);
    await expect(
      runStructuredAgent({
        stage: "plan",
        role: "planner",
        model,
        system: "s",
        prompt: "p",
        schema: Answer,
        usage,
      }),
    ).rejects.toMatchObject({
      name: "TokenBudgetExceededError",
    });
    expect(eventNames()).toContain("budget.exceeded");
  });

  it("tool errors are reported to the model and journaled", async () => {
    const { guard, usage, journal } = setup();
    const failing: AgentTool = {
      name: "read_file",
      description: "r",
      inputSchema: z.object({ path: z.string() }),
      execute: () => Promise.reject(new Error("ENOENT")),
    };
    const model = scriptedModel([
      { tools: [{ name: "read_file", input: { path: "x" } }] },
      { text: '{"answer": 1}' },
    ]);
    await runStructuredAgent({
      stage: "s",
      role: "analyst",
      model,
      system: "s",
      prompt: "p",
      schema: Answer,
      tools: [failing],
      guard,
      usage,
    });
    expect(promptOf(model, 1)).toContain("ERROR: ENOENT");
    expect(journal.at(-1)).toContain("ERROR: ENOENT");
  });

  it("extractJson reads fenced blocks and bare objects", () => {
    expect(extractJson('text ```json\n{"a":1}\n``` more')).toEqual({ a: 1 });
    expect(extractJson('Sure: {"a":{"b":2}} done')).toEqual({ a: { b: 2 } });
    expect(() => extractJson("no json")).toThrow();
  });

  it("REQ-LLM-04/AC3: repair rounds on structured-output models use schema-constrained decoding without tools", async () => {
    const { guard, usage } = setup();
    const model = scriptedModel([{ text: "not json" }, { text: '{"answer": 5}' }]);
    const result = await runStructuredAgent({
      stage: "s",
      role: "analyst",
      model,
      system: "s",
      prompt: "p",
      schema: Answer,
      tools,
      guard,
      usage,
    });
    expect(result).toEqual({ value: { answer: 5 }, attempts: 2 });
    expect(model.mock.doGenerateCalls[0]?.tools).toBeDefined();
    expect(model.mock.doGenerateCalls[1]?.tools).toBeUndefined();
    expect(model.mock.doGenerateCalls[1]?.responseFormat).toMatchObject({ type: "json" });
  });

  it("REQ-LLM-04/AC2: a constrained round that yields no object counts as a failed attempt", async () => {
    const { usage } = setup();
    const model = scriptedModel([{ text: "nope" }, { text: "still nope" }, { text: '{"answer": 3}' }]);
    const result = await runStructuredAgent({
      stage: "s",
      role: "analyst",
      model,
      system: "s",
      prompt: "p",
      schema: Answer,
      usage,
    });
    expect(result.attempts).toBe(3);
  });

  it("REQ-LLM-04/AC3: decoding schemas keep structure but drop patterns and formats", () => {
    const schema = decodingSchema(
      z.object({
        id: z.string().regex(/^TC-\d+$/),
        url: z.url(),
        n: z.number().int().min(1),
        kind: z.enum(["a", "b"]),
      }),
    );
    expect(JSON.stringify(schema)).not.toMatch(/pattern|format|minimum/);
    expect(schema).toMatchObject({
      type: "object",
      required: ["id", "url", "n", "kind"],
      properties: { kind: { enum: ["a", "b"] } },
    });
  });

  it("REQ-LLM-04/AC3: a provider that rejects constrained decoding falls back to JSON mode", async () => {
    const { usage } = setup();
    const model = scriptedModel([{ text: "nope" }, { text: '{"answer": 9}' }]);
    let calls = 0;
    const original = model.mock.doGenerate.bind(model.mock);
    model.mock.doGenerate = (options) => {
      calls += 1;
      if (options.responseFormat?.type === "json" && options.responseFormat.schema !== undefined) {
        return Promise.reject(new Error("Failed to initialize samplers: failed to parse grammar"));
      }
      return original(options);
    };
    const result = await runStructuredAgent({
      stage: "s",
      role: "analyst",
      model,
      system: "s",
      prompt: "p",
      schema: Answer,
      usage,
    });
    expect(result).toEqual({ value: { answer: 9 }, attempts: 3 });
    expect(calls).toBe(3);
  });
});
