// Contract of the Anthropic path against the documented Claude Messages API (REQ-LLM-01/AC6), without a key or
// network: tests/support/anthropic-api.ts answers like the API and refuses requests the documentation does not allow.
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import {
  createUsageTracker,
  runPlanner,
  runStructuredAgent,
  buildChangeContext,
  type AgentStageDeps,
} from "@qajitsu/agents";
import { createEventLog, parseEventLines } from "@qajitsu/core";
import { createModelRegistry } from "@qajitsu/models";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createAnthropicApi, type AnthropicTurn } from "../support/anthropic-api.js";
import { createFetchedRun } from "../support/run-fixture.js";

const KEY = "sk-ant-api03-contract-test-key-000000";
const MODEL = "anthropic/claude-sonnet-5-5";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const setup = async (script: readonly AnthropicTurn[]) => {
  const api = createAnthropicApi(script, { apiKey: KEY });
  const registry = createModelRegistry({
    config: {
      providers: { anthropic: { type: "anthropic", api_key: "secret://env/ANTHROPIC_API_KEY", models: {} } },
      roles: { default: MODEL },
      token_budget: 1_000_000,
    } as never,
    resolveSecret: (ref) =>
      ref === "secret://env/ANTHROPIC_API_KEY" ? Promise.resolve(KEY) : Promise.reject(new Error(ref)),
    fetch: api.fetch,
  });
  const model = await registry.resolve(MODEL);
  const lines: string[] = [];
  const events = createEventLog({
    ticket: "DEMO-1",
    run: "r",
    write: (l) => lines.push(l),
    now: () => new Date(0),
    mask: (v) => v,
  });
  const usage = createUsageTracker({ events });
  const usageEvents = () =>
    parseEventLines(lines.join(""))
      .events.filter((e) => e.event === "model.usage")
      .map((e) => e.details as Record<string, unknown>);
  return { api, model, events, usage, usageEvents };
};

describe("Anthropic Messages API contract (REQ-LLM-01/AC6)", () => {
  it("REQ-LLM-01/AC6: a request carries the documented headers and fields; the text answer and its usage are read", async () => {
    const s = await setup([{ text: '{"answer":"ok"}', usage: { input: 120, output: 30 } }]);
    const out = await runStructuredAgent({
      stage: "plan",
      role: "planner",
      model: s.model,
      system: "You are the planner.",
      prompt: "Answer with JSON.",
      schema: z.object({ answer: z.string() }),
      usage: s.usage,
    });
    expect(out).toEqual({ value: { answer: "ok" }, attempts: 1 });
    expect(s.api.violations).toEqual([]);
    expect(s.api.requests[0]).toMatchObject({
      model: "claude-sonnet-5-5",
      system: [{ type: "text", text: "You are the planner." }],
    });
    expect(s.usageEvents()).toEqual([
      expect.objectContaining({ model: MODEL, inputTokens: 120, outputTokens: 30 }),
    ]);
  });

  it("REQ-LLM-01/AC6: a second attempt uses documented structured outputs (output_config.format), never forced tool use or prefill", async () => {
    const s = await setup([{ text: "Sure! Here is the plan." }, { text: '{"answer":"ok"}' }]);
    const out = await runStructuredAgent({
      stage: "plan",
      role: "planner",
      model: s.model,
      system: "sys",
      prompt: "Answer with JSON.",
      schema: z.object({ answer: z.string() }),
      usage: s.usage,
    });
    expect(out.attempts).toBe(2);
    expect(s.api.violations).toEqual([]);
    expect(s.api.requests[1]?.output_config?.format?.type).toBe("json_schema");
    expect(s.api.requests.every((r) => r.tool_choice === undefined || r.tool_choice.type === "auto")).toBe(
      true,
    );
  });

  it("REQ-LLM-01/AC6: a tool call round trip sends the tool_result for the tool_use id; usage counts every step", async () => {
    const { root, ws } = await createFetchedRun();
    roots.push(root);
    const draft = readFileSync(new URL("../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8");
    const s = await setup([
      { tool: { name: "read_file", input: { path: "ticket/ticket.json" } } },
      { text: draft, usage: { input: 900, output: 400 } },
    ]);
    const deps: AgentStageDeps = {
      ws,
      models: { forRole: () => Promise.resolve(s.model), resolve: () => Promise.resolve(s.model) },
      events: s.events,
      usage: s.usage,
      now: () => new Date(0),
      maskJson: (v) => v,
      maskText: (t) => t,
    };
    const plan = await runPlanner(deps, await buildChangeContext(ws), {
      summary: "s",
      change_type: ["api"],
      endpoints: [],
      screens: [],
      risks: [],
      confidence: "high",
      open_questions: [],
    });
    expect(plan.cases.map((c) => c.id)).toEqual(["TC-01", "TC-02"]);
    expect(s.api.violations).toEqual([]);
    expect(s.api.requests[0]?.tools?.map((t) => t.name)).toEqual(
      expect.arrayContaining(["read_file", "list_files", "search_code"]),
    );
    const second = s.api.requests[1]?.messages ?? [];
    const toolUse = (second.at(-2)?.content as { type: string; id?: string }[]).find(
      (b) => b.type === "tool_use",
    );
    const toolResult = (
      second.at(-1)?.content as { type: string; tool_use_id?: string; content?: unknown }[]
    ).find((b) => b.type === "tool_result");
    expect(toolResult?.tool_use_id).toBe(toolUse?.id);
    expect(JSON.stringify(toolResult?.content)).toContain("DEMO-1");
    // Both steps count: 50/25 for the tool call and 900/400 for the answer.
    expect(s.usageEvents()).toEqual([expect.objectContaining({ inputTokens: 950, outputTokens: 425 })]);
  });

  it("REQ-LLM-01/AC6: documented 429 and 529 are retried; 401 fails at once without the key in the error", async () => {
    const retried = await setup([{ error: 429, retryAfter: 0 }, { error: 529 }, { text: '{"answer":"ok"}' }]);
    const ok = await runStructuredAgent({
      stage: "plan",
      role: "planner",
      model: retried.model,
      system: "sys",
      prompt: "p",
      schema: z.object({ answer: z.string() }),
      usage: retried.usage,
    });
    expect(ok.value).toEqual({ answer: "ok" });
    expect(retried.api.requests).toHaveLength(3);

    const denied = await setup([{ error: 401 }, { text: '{"answer":"never"}' }]);
    const error = await runStructuredAgent({
      stage: "plan",
      role: "planner",
      model: denied.model,
      system: "sys",
      prompt: "p",
      schema: z.object({ answer: z.string() }),
      usage: denied.usage,
    }).catch((e: unknown) => e);
    expect(String(error)).toMatch(/invalid x-api-key/);
    expect(JSON.stringify(error) + String(error)).not.toContain(KEY);
    expect(denied.api.requests).toHaveLength(1);
  });
});
