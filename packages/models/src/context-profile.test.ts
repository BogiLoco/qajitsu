import { describe, expect, it } from "vitest";
import {
  contextBudget,
  contextProfile,
  CONTEXT_PROFILE_VERSION,
  renderForProvider,
} from "./context-profile.js";
import { createModelRegistry } from "./registry.js";

describe("context profiles and renderers (REQ-LLM-15)", () => {
  it("REQ-LLM-15/AC1+AC4: the working range stays below the window; small windows and local models are compact", () => {
    const claude = contextProfile("anthropic", { contextWindow: 200_000 });
    expect(claude).toMatchObject({
      version: CONTEXT_PROFILE_VERSION,
      window: 200_000,
      workingRange: 150_000,
      answerReserve: 8_192,
      margin: 1.35,
      counting: "provider",
      cache: "explicit",
      style: "full",
    });
    expect(contextProfile("ollama", { contextWindow: 40_960 })).toMatchObject({
      workingRange: 32_768,
      answerReserve: 2_048,
      cache: "none",
      style: "compact",
    });
    // A benchmark's measured range and a chosen style override the defaults, never above the window.
    expect(
      contextProfile("openai", { contextWindow: 128_000 }, { workingRange: 500_000, style: "compact" }),
    ).toMatchObject({
      workingRange: 128_000,
      style: "compact",
    });
    expect(contextBudget(claude)).toBe(150_000 - 8_192);
    expect(contextBudget(claude, 40_000)).toBe(40_000 - 8_192);
  });

  it("REQ-LLM-15/AC2: Anthropic counts with its own endpoint; the key and the request shape are the provider's", async () => {
    const requests: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const registry = createModelRegistry({
      config: {
        providers: {
          claude: {
            type: "anthropic",
            api_key: "secret://env/KEY",
            models: { "claude-sonnet-5-5": { context_window: 200_000, working_range: 120_000 } },
          },
        },
        roles: {},
      } as never,
      resolveSecret: () => Promise.resolve("sk-test-key"),
      fetch: (url, init) => {
        requests.push({
          url: url instanceof Request ? url.url : url.toString(),
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown,
        });
        return Promise.resolve(new Response(JSON.stringify({ input_tokens: 1234 }), { status: 200 }));
      },
    });
    const model = await registry.resolve("claude/claude-sonnet-5-5");
    expect(model.context.workingRange).toBe(120_000);
    expect(await model.countTokens?.("system text", "prompt text")).toBe(1234);
    expect(requests[0]).toMatchObject({
      url: "https://api.anthropic.com/v1/messages/count_tokens",
      headers: { "x-api-key": "sk-test-key", "anthropic-version": "2023-06-01" },
      body: {
        model: "claude-sonnet-5-5",
        system: "system text",
        messages: [{ role: "user", content: "prompt text" }],
      },
    });
  });

  it("REQ-LLM-15/AC3+AC5: the renderer follows the cache style; a provider without a profile gets the general one", () => {
    const options = { anthropic: { cacheControl: { type: "ephemeral" } } };
    const messages = [
      { role: "user", content: "stable prefix" },
      { role: "user", content: "repair" },
    ];
    const explicit = renderForProvider(
      { context: contextProfile("anthropic", { contextWindow: 200_000 }), cacheOptions: options },
      "system",
      messages,
    );
    expect(explicit.system).toEqual({ role: "system", content: "system", providerOptions: options });
    expect(explicit.messages[0]).toEqual({
      role: "user",
      content: "stable prefix",
      providerOptions: options,
    });
    expect(explicit.messages[1]).toEqual({ role: "user", content: "repair" });
    const prefix = renderForProvider(
      { context: contextProfile("openai", { contextWindow: 128_000 }) },
      "system",
      messages,
    );
    expect(prefix).toEqual({ system: "system", messages });
    // A provider QAJitsu has no profile for yet: the general defaults, the same renderer; the context manager is
    // untouched (a new provider is a profile entry and, for a new cache style, a renderer).
    expect(contextProfile("some-new-provider", { contextWindow: 100_000 })).toMatchObject({
      workingRange: 70_000,
      cache: "none",
      counting: "estimate",
    });
  });
});
