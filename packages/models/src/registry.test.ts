import { parseProjectConfig } from "@qajitsu/core";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createFakeFetch, jsonReply } from "../../../tests/support/fake-fetch.js";
import { modelProfile } from "./capabilities.js";
import { createModelRegistry } from "./registry.js";

const config = parseProjectConfig({
  project: "demo",
  jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
  models: {
    providers: {
      claude: { type: "anthropic", api_key: "secret://env/ANTHROPIC_API_KEY" },
      gpt: { type: "openai", api_key: "secret://env/OPENAI_API_KEY" },
      gem: { type: "google", api_key: "secret://env/GOOGLE_API_KEY" },
      local: {
        type: "ollama",
        base_url: "http://localhost:11434/api",
        models: { "my-model": { tools: true, context_window: 65536 } },
      },
      company: {
        type: "openai-compatible",
        base_url: "https://litellm.example.com/v1",
        api_key: "secret://env/LITELLM_KEY",
      },
    },
    roles: { default: "claude/claude-sonnet-5", planner: "company/strong", summary: "local/qwen3:32b" },
  },
}).models;

const secrets: Record<string, string> = {
  "secret://env/ANTHROPIC_API_KEY": "anthropic-key",
  "secret://env/OPENAI_API_KEY": "openai-key",
  "secret://env/GOOGLE_API_KEY": "google-key",
  "secret://env/LITELLM_KEY": "litellm-key",
};
const resolveSecret = (ref: string): Promise<string> => Promise.resolve(secrets[ref] ?? "");

describe("model registry (REQ-LLM-01, REQ-LLM-02)", () => {
  it("REQ-LLM-01/AC1: builds Anthropic, OpenAI and Google models through the AI SDK", async () => {
    const registry = createModelRegistry({ config, resolveSecret });
    for (const [ref, provider] of [
      ["claude/claude-sonnet-5", "anthropic"],
      ["gpt/gpt-5", "openai"],
      ["gem/gemini-3-pro", "google"],
    ] as const) {
      const resolved = await registry.resolve(ref);
      expect(typeof resolved.model === "object" && resolved.model.provider).toContain(provider);
      expect(resolved.profile.tools).toBe(true);
    }
  });

  it("REQ-LLM-01/AC3: OpenAI-compatible endpoints (LiteLLM) get base URL and API key", async () => {
    const fake = createFakeFetch([
      {
        method: "POST",
        match: /^\/v1\/chat\/completions$/,
        reply: jsonReply({
          id: "1",
          object: "chat.completion",
          created: 0,
          model: "strong",
          choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
      },
    ]);
    const registry = createModelRegistry({ config, resolveSecret, fetch: fake.fetch });
    const planner = await registry.forRole("planner");
    expect(planner.id).toBe("company/strong");
    const result = await generateText({ model: planner.model, prompt: "ping" });
    expect(result.text).toBe("OK");
    expect(fake.requests[0]?.url.origin).toBe("https://litellm.example.com");
    expect(fake.requests[0]?.headers["authorization"]).toBe("Bearer litellm-key");
  });

  it("REQ-LLM-01/AC2: Ollama models talk to the configured base URL", async () => {
    const fake = createFakeFetch([
      {
        method: "POST",
        match: /^\/api\/chat$/,
        reply: jsonReply({
          model: "qwen3:32b",
          created_at: "2026-10-03T00:00:00Z",
          message: { role: "assistant", content: "OK" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 3,
          eval_count: 1,
        }),
      },
    ]);
    const registry = createModelRegistry({ config, resolveSecret, fetch: fake.fetch });
    const summary = await registry.forRole("summary");
    expect(summary.profile).toMatchObject({ tools: true, contextWindow: 32_768 });
    const result = await generateText({ model: summary.model, prompt: "ping" });
    expect(result.text).toBe("OK");
    expect(fake.requests[0]?.url.href).toBe("http://localhost:11434/api/chat");
    const mine = await registry.resolve("local/my-model");
    await generateText({ model: mine.model, prompt: "ping" }).catch(() => undefined);
    expect(JSON.parse(fake.requests[1]?.body ?? "{}")).toMatchObject({ options: { num_ctx: 65536 } });
  });

  it("REQ-LLM-02/AC1: roles fall back to default; unknown providers are configuration errors", async () => {
    const registry = createModelRegistry({ config, resolveSecret });
    expect((await registry.forRole("analyst")).id).toBe("claude/claude-sonnet-5");
    await expect(registry.resolve("nope/x")).rejects.toMatchObject({ code: "MODEL_PROVIDER_UNKNOWN" });
  });

  it("injects extra providers such as mock models for tests", async () => {
    const mock = new MockLanguageModelV4();
    const registry = createModelRegistry({ config, resolveSecret, extra: { mock: () => mock } });
    const resolved = await registry.resolve("mock/any");
    expect(resolved.model).toBe(mock);
    expect(resolved.profile.tools).toBe(true);
  });
});

describe("capability profiles (REQ-LLM-03)", () => {
  it("REQ-LLM-03/AC1: built-in profiles are conservative for unknown local models; config overrides win", () => {
    expect(modelProfile("ollama", "some-unknown:7b")).toMatchObject({
      tools: false,
      structuredOutput: false,
    });
    expect(
      modelProfile("ollama", "some-unknown:7b", {
        tools: true,
        structured_output: true,
        context_window: 65536,
        cost_per_mtok: { input: 0, output: 0 },
      }),
    ).toEqual({
      tools: true,
      structuredOutput: true,
      vision: false,
      contextWindow: 65536,
      costPerMTok: { input: 0, output: 0 },
    });
    expect(modelProfile("anthropic", "claude-haiku-4-5")).toMatchObject({
      vision: true,
      contextWindow: 200_000,
    });
  });
});
