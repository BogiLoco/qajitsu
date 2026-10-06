import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { ConfigError, type Embedder, type ProjectConfig } from "@qajitsu/core";
import { embedMany, type EmbeddingModel } from "ai";
import { createOllama } from "ai-sdk-ollama";
import { parseModelRef } from "./model-ref.js";

const LOOPBACK = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i;

/**
 * An embedding model `<provider>/<model>` from `models.providers` for the knowledge base (REQ-KNOW-08/AC1). It is
 * local when the provider is Ollama or its base URL is a loopback address (REQ-KNOW-09/AC2). Provider SDKs are only
 * imported in this package (invariant 11).
 *
 * @param options - Models config, secret resolver and an optional fetch (tests, proxies).
 * @param reference - `<provider>/<model>`, e.g. `ollama/nomic-embed-text`.
 * @throws {ConfigError} `MODEL_PROVIDER_UNKNOWN`, `EMBEDDING_UNSUPPORTED` (Anthropic has no embedding models).
 * @example
 * const embedder = await createEmbedder({ config: project.config.models, resolveSecret }, "ollama/nomic-embed-text");
 * const [vector] = await embedder.embed(["cancel a paid order"]);
 */
export async function createEmbedder(
  options: {
    readonly config: ProjectConfig["models"];
    readonly resolveSecret: (reference: string) => Promise<string>;
    readonly fetch?: typeof globalThis.fetch;
  },
  reference: string,
): Promise<Embedder> {
  const ref = parseModelRef(reference);
  const provider = options.config.providers[ref.provider];
  if (!provider)
    throw new ConfigError("MODEL_PROVIDER_UNKNOWN", `No provider '${ref.provider}' in models.providers.`, {
      provider: ref.provider,
      available: Object.keys(options.config.providers),
    });
  const apiKey = provider.api_key === undefined ? undefined : await options.resolveSecret(provider.api_key);
  const common = {
    ...(provider.base_url ? { baseURL: provider.base_url } : {}),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
  let model: EmbeddingModel;
  switch (provider.type) {
    case "anthropic":
      throw new ConfigError(
        "EMBEDDING_UNSUPPORTED",
        `Provider '${ref.provider}' (anthropic) has no embedding models; use ollama, openai, google or an OpenAI-compatible provider.`,
        { provider: ref.provider },
      );
    case "openai":
      model = createOpenAI(common).embeddingModel(ref.model);
      break;
    case "google":
      model = createGoogle(common).embeddingModel(ref.model);
      break;
    case "ollama":
      // ai-sdk-ollama wants the host URL; accept the common `.../api` form too.
      model = createOllama({
        ...common,
        ...(provider.base_url ? { baseURL: provider.base_url.replace(/\/api\/?$/, "") } : {}),
      }).embeddingModel(ref.model);
      break;
    case "openai-compatible":
      model = createOpenAICompatible({
        name: ref.provider,
        baseURL: provider.base_url ?? "",
        ...common,
      }).embeddingModel(ref.model);
      break;
  }
  return {
    id: `${ref.provider}/${ref.model}`,
    local: provider.type === "ollama" || LOOPBACK.test(provider.base_url ?? ""),
    embed: async (texts) =>
      texts.length === 0
        ? []
        : (await embedMany({ model, values: [...texts], maxParallelCalls: 2 })).embeddings,
  };
}
