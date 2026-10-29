import { createContextManager } from "./context-manager.js";
import { createModelRegistry } from "@qajitsu/models";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { scriptedModel } from "../../../tests/support/mock-model.js";
import { prepareCall } from "./prepare-call.js";
import { callUsage } from "./usage.js";

/** prepareCall takes an assembled context: its system message and snapshot. */
const ctx = (system: string) => ({
  system,
  snapshot: createContextManager({ marker: "testmarker00" }).assemble({
    stage: "t",
    role: "t",
    model: "m",
    fragments: [],
  }).snapshot,
});

/** An Anthropic provider whose HTTP calls are captured and answered with a recorded-shape message. */
const anthropic = (cacheTtl: "5m" | "1h" | "off") => {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [{ type: "text", text: "{}" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 1200,
            output_tokens: 2,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 0,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };
  const registry = createModelRegistry({
    config: {
      providers: { claude: { type: "anthropic", api_key: "secret://env/KEY", models: {} } },
      roles: { default: "claude/claude-sonnet-5-5" },
      cache_ttl: cacheTtl,
    },
    resolveSecret: () => Promise.resolve("sk-ant-test"),
    fetch,
    cacheTtl,
  });
  return { registry, bodies };
};

describe("prompt caching and input limits (REQ-LLM-12)", () => {
  it("REQ-LLM-12/AC1+AC5: an Anthropic call marks the instructions and the context message as a cache breakpoint; the cache read comes back in the usage", async () => {
    const { registry, bodies } = anthropic("1h");
    const model = await registry.forRole("planner");
    const result = await generateText({
      model: model.model,
      ...prepareCall(model, ctx("You plan tests."), [
        { role: "user", content: "Ticket and repository context" },
        { role: "assistant", content: "{" },
        { role: "user", content: "Fix the JSON" },
      ]),
    });
    const body = bodies[0] as {
      system: { cache_control?: unknown }[];
      messages: { content: { cache_control?: unknown }[] }[];
    };
    expect(body.system[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(body.messages[0]?.content.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(body.messages[2]?.content.at(-1)?.cache_control).toBeUndefined();
    expect(callUsage(result.usage)).toMatchObject({ cachedInputTokens: 1000 });
  });

  it("REQ-LLM-12/AC1: with the cache off, or a provider that caches by itself, nothing is marked", async () => {
    const { registry, bodies } = anthropic("off");
    const model = await registry.forRole("planner");
    expect(model.cacheOptions).toBeUndefined();
    await generateText({
      model: model.model,
      ...prepareCall(model, ctx("You plan tests."), [{ role: "user", content: "x" }]),
    });
    expect(JSON.stringify(bodies[0])).not.toContain("cache_control");
  });

  it("REQ-LLM-12/AC4: a call over the model's limit is stopped before anything is sent, with the estimate and why", () => {
    const model = { ...scriptedModel([]), inputLimit: { limit: 100, why: "models.max_input_tokens" } };
    expect(() => prepareCall(model, ctx("s"), [{ role: "user", content: "x".repeat(1000) }])).toThrow(
      /would send about 251 input tokens, over 100 \(models\.max_input_tokens\); nothing was sent/,
    );
    try {
      prepareCall(model, ctx("s"), [{ role: "user", content: [{ type: "text", text: "x".repeat(1000) }] }]);
    } catch (error) {
      expect((error as { code?: string }).code).toBe("MODEL_INPUT_TOO_LARGE");
    }
    expect(prepareCall(model, ctx("s"), [{ role: "user", content: "short" }])).toEqual({
      system: "s",
      messages: [{ role: "user", content: "short" }],
    });
  });
});
