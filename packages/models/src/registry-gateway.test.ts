import { readFileSync } from "node:fs";
import { parseProjectConfig } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createFakeFetch, jsonReply, textReply, type Route } from "../../../tests/support/fake-fetch.js";
import { memoryGatewayCache } from "./gateway.js";
import { createModelRegistry } from "./registry.js";

const modelInfo = JSON.parse(
  readFileSync(new URL("../../../fixtures/models/litellm-model-info.json", import.meta.url), "utf8"),
) as unknown;
const KEY = ["litellm", "-", "key", "-", "fictional", "-", "778899"].join("");
const config = (models: Record<string, unknown> = {}) =>
  parseProjectConfig({
    project: "demo",
    jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
    models: {
      providers: {
        company: {
          type: "openai-compatible",
          base_url: "https://litellm.example.test/v1",
          api_key: "secret://env/LITELLM_KEY",
          gateway: "litellm",
          models,
        },
      },
      roles: { default: "company/strong", summary: "company/inhouse" },
    },
  }).models;
const registry = (routes: Route[], models?: Record<string, unknown>) => {
  const fake = createFakeFetch(routes);
  const warnings: string[] = [];
  const reg = createModelRegistry({
    config: config(models),
    resolveSecret: () => Promise.resolve(KEY),
    fetch: fake.fetch,
    gatewayCache: memoryGatewayCache(),
    onWarning: (m) => warnings.push(m),
    now: () => new Date("2026-11-17T10:00:00Z"),
  });
  return { reg, fake, warnings };
};
const info: Route = { match: /^\/v1\/model\/info$/, reply: jsonReply(modelInfo) };

describe("a gateway provider's models (REQ-LLM-10)", () => {
  it("REQ-LLM-10/AC1+AC3: a role on a LiteLLM alias gets the gateway's profile, with sources and read time", async () => {
    const { reg, fake } = registry([info]);
    const author = await reg.forRole("author");
    expect(author.profile).toMatchObject({
      tools: true,
      vision: true,
      structuredOutput: true,
      contextWindow: 200_000,
    });
    expect(author.profile.costPerMTok).toMatchObject({ input: 3, output: 15 });
    expect(author.sources).toEqual({
      tools: "gateway",
      vision: "gateway",
      structuredOutput: "gateway",
      contextWindow: "gateway",
      price: "gateway",
    });
    expect(author.gatewayReadAt).toBe("2026-11-17T10:00:00.000Z");
    await reg.forRole("planner");
    await reg.forRole("summary");
    // One read for every model of the provider.
    expect(fake.requests.filter((r) => r.url.pathname === "/v1/model/info")).toHaveLength(1);
  });

  it("REQ-LLM-10/AC2: a declared value wins; a capability the gateway does not report stays unknown", async () => {
    const { reg } = registry([info], {
      inhouse: { structured_output: true },
      strong: { context_window: 100_000 },
    });
    const summary = await reg.forRole("summary");
    expect(summary.profile).toMatchObject({
      tools: true,
      vision: false,
      structuredOutput: true,
      contextWindow: 64_000,
    });
    expect(summary.sources).toMatchObject({ structuredOutput: "config", tools: "gateway", price: "unknown" });
    expect((await reg.forRole("author")).profile.contextWindow).toBe(100_000);
    const bare = registry([info]);
    const unknown = await bare.reg.forRole("summary");
    expect(unknown.profile.structuredOutput).toBe(false);
    expect(unknown.sources?.structuredOutput).toBe("unknown");
  });

  it("REQ-LLM-10/AC4: a gateway that does not answer falls back to the config with a warning naming no key", async () => {
    const { reg, warnings } = registry([{ match: /^\/v1\/model\/info$/, reply: textReply("down", 503) }], {
      strong: { tools: true, structured_output: true, vision: true, context_window: 150_000 },
    });
    const author = await reg.forRole("author");
    expect(author.profile.contextWindow).toBe(150_000);
    expect(author.sources).toMatchObject({ contextWindow: "config", tools: "config" });
    expect(author.gatewayReadAt).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("The litellm gateway company did not answer: HTTP 503.");
    expect(warnings[0]).toContain("Using the configured and built-in profiles.");
    expect(warnings.join("")).not.toContain(KEY);
  });

  it("REQ-LLM-10/AC4: the key goes to the gateway's own address and nowhere else", async () => {
    const { reg, fake } = registry([info]);
    await reg.forRole("author");
    for (const r of fake.requests) {
      expect(r.url.origin).toBe("https://litellm.example.test");
      expect(r.headers["authorization"]).toBe(`Bearer ${KEY}`);
    }
  });

  it("REQ-FLOW-06/AC7: a model served from this machine costs nothing; a remote one without a price stays unpriced", async () => {
    const make = (base_url: string, models: Record<string, unknown> = {}) =>
      createModelRegistry({
        config: parseProjectConfig({
          project: "demo",
          jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
          models: {
            providers: { vllm: { type: "openai-compatible", base_url, models } },
            roles: { default: "vllm/qwen" },
          },
        }).models,
        resolveSecret: () => Promise.resolve(""),
        fetch: createFakeFetch([]).fetch,
      });
    expect((await make("http://localhost:8000/v1").forRole("author")).profile.costPerMTok).toEqual({
      input: 0,
      output: 0,
    });
    expect((await make("http://127.0.0.1:1234/v1").forRole("author")).profile.costPerMTok).toEqual({
      input: 0,
      output: 0,
    });
    expect(
      (await make("https://vllm.example.test/v1").forRole("author")).profile.costPerMTok,
    ).toBeUndefined();
    // A declared price wins, also for a local model (someone pays for that GPU).
    const declared = await make("http://localhost:8000/v1", {
      qwen: { cost_per_mtok: { input: 0.1, output: 0.2 } },
    }).forRole("author");
    expect(declared.profile.costPerMTok).toEqual({ input: 0.1, output: 0.2 });
  });

  it("REQ-FLOW-06/AC7: a gateway on this machine is not free; a model it gives no price stays unpriced", async () => {
    const reg = createModelRegistry({
      config: parseProjectConfig({
        project: "demo",
        jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
        models: {
          providers: {
            proxy: { type: "openai-compatible", base_url: "http://localhost:4000/v1", gateway: "litellm" },
          },
          roles: { default: "proxy/strong", summary: "proxy/inhouse" },
        },
      }).models,
      resolveSecret: () => Promise.resolve(""),
      fetch: createFakeFetch([info]).fetch,
      gatewayCache: memoryGatewayCache(),
      now: () => new Date("2026-11-17T10:00:00Z"),
    });
    // LiteLLM forwards to paid providers: its own prices count, a model without one is not $0.
    expect((await reg.forRole("author")).profile.costPerMTok?.input).toBe(3);
    expect((await reg.forRole("summary")).profile.costPerMTok).toBeUndefined();
  });

  it("REQ-LLM-12/AC3: Anthropic, OpenAI and Google models have a batch at half price; local and compatible ones do not", async () => {
    const reg = createModelRegistry({
      config: parseProjectConfig({
        project: "demo",
        jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
        models: {
          providers: {
            claude: { type: "anthropic", api_key: "secret://env/A" },
            gpt: { type: "openai", api_key: "secret://env/O" },
            gem: { type: "google", api_key: "secret://env/G" },
            local: { type: "ollama", base_url: "http://localhost:11434" },
            vllm: { type: "openai-compatible", base_url: "http://localhost:8000/v1" },
          },
          roles: { default: "claude/claude-sonnet-5" },
        },
      }).models,
      resolveSecret: () => Promise.resolve("fictional-key"),
      fetch: createFakeFetch([]).fetch,
    });
    for (const ref of ["claude/claude-haiku-5", "gpt/gpt-6", "gem/gemini-4-argon"])
      expect((await reg.resolve(ref)).batch?.priceFactor, ref).toBe(0.5);
    for (const ref of ["local/qwen3", "vllm/qwen"])
      expect((await reg.resolve(ref)).batch, ref).toBeUndefined();
  });
});
