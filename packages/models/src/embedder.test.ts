import { parseProjectConfig } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createFakeFetch, jsonReply } from "../../../tests/support/fake-fetch.js";
import { createEmbedder } from "./embedder.js";

const { models } = parseProjectConfig({
  project: "demo",
  jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
  models: {
    providers: {
      claude: { type: "anthropic", api_key: "secret://env/ANTHROPIC_API_KEY" },
      local: { type: "ollama", base_url: "http://localhost:11434/api" },
      company: {
        type: "openai-compatible",
        base_url: "https://litellm.example.com/v1",
        api_key: "secret://env/LITELLM_KEY",
      },
      proxy: { type: "openai-compatible", base_url: "http://127.0.0.1:4000/v1" },
    },
    roles: { default: "claude/claude-sonnet-5" },
  },
});
const resolveSecret = (ref: string) => Promise.resolve(ref.endsWith("LITELLM_KEY") ? "litellm-key" : "x");

describe("embedding models (REQ-KNOW-08)", () => {
  it("REQ-KNOW-08/AC1 + REQ-KNOW-09/AC2: Ollama embeddings are local and use the configured host", async () => {
    const fake = createFakeFetch([
      {
        method: "POST",
        match: /^\/api\/embed$/,
        reply: (req) => {
          const input = (JSON.parse(req.body ?? "{}") as { input: string | string[] }).input;
          const texts = Array.isArray(input) ? input : [input];
          return jsonReply({
            model: "nomic-embed-text",
            embeddings: texts.map((t) => (t === "a" ? [0.1, 0.2] : [0.3, 0.4])),
          })(req);
        },
      },
    ]);
    const embedder = await createEmbedder(
      { config: models, resolveSecret, fetch: fake.fetch },
      "local/nomic-embed-text",
    );
    expect(embedder).toMatchObject({ id: "local/nomic-embed-text", local: true });
    expect(await embedder.embed(["a", "b"])).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(await embedder.embed([])).toEqual([]);
    expect(fake.requests[0]?.url.href).toBe("http://localhost:11434/api/embed");
  });

  it("REQ-KNOW-08/AC1 + REQ-KNOW-09/AC2: a remote OpenAI-compatible endpoint is not local; a loopback one is", async () => {
    const fake = createFakeFetch([
      {
        method: "POST",
        match: /^\/v1\/embeddings$/,
        reply: jsonReply({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [1, 0] }],
          model: "e",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      },
    ]);
    const remote = await createEmbedder(
      { config: models, resolveSecret, fetch: fake.fetch },
      "company/text-embed",
    );
    expect(remote.local).toBe(false);
    expect(await remote.embed(["a"])).toEqual([[1, 0]]);
    expect(fake.requests[0]?.headers["authorization"]).toBe("Bearer litellm-key");
    expect((await createEmbedder({ config: models, resolveSecret }, "proxy/e")).local).toBe(true);
  });

  it("REQ-KNOW-08/AC1: Anthropic and unknown providers are configuration errors", async () => {
    await expect(createEmbedder({ config: models, resolveSecret }, "claude/x")).rejects.toMatchObject({
      code: "EMBEDDING_UNSUPPORTED",
    });
    await expect(createEmbedder({ config: models, resolveSecret }, "nope/x")).rejects.toMatchObject({
      code: "MODEL_PROVIDER_UNKNOWN",
    });
  });
});
