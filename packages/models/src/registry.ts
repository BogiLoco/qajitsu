import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { ConfigError, type ModelProvider, type ProjectConfig } from "@qajitsu/core";
import type { LanguageModel } from "ai";
import { createOllama } from "ai-sdk-ollama";
import { modelProfile, type ModelProfile } from "./capabilities.js";
import { parseModelRef, resolveRoleModel, type ModelRef, type ModelRole } from "./model-ref.js";

/** A resolved model: AI SDK handle plus its capability profile. */
export interface ResolvedModel {
  readonly ref: ModelRef;
  /** `<provider>/<model>` as configured. */
  readonly id: string;
  readonly model: LanguageModel;
  readonly profile: ModelProfile;
}

/** Access to the configured models: the core ModelProvider with AI SDK types (ADR-0005). */
export interface ModelRegistry extends ModelProvider {
  /** Resolves `<provider>/<model>`. */
  resolve(reference: string): Promise<ResolvedModel>;
  /** Resolves the model of an agent role (REQ-LLM-02). */
  forRole(role: ModelRole): Promise<ResolvedModel>;
}

type ProviderConfig = ProjectConfig["models"]["providers"][string];

/**
 * Creates the model registry from `models` in `.qa/qa.project.yaml` (REQ-LLM-01, REQ-LLM-02).
 * Provider SDKs are only imported here (invariant 11).
 *
 * @param options - Models config, secret resolver and an optional fetch (tests, proxies).
 * @example
 * const models = createModelRegistry({ config: project.config.models, resolveSecret });
 * const planner = await models.forRole("planner");
 */
export function createModelRegistry(options: {
  readonly config: ProjectConfig["models"];
  readonly resolveSecret: (reference: string) => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  /** Extra providers by alias, e.g. a mock model in tests; they win over configured ones. */
  readonly extra?: Readonly<Record<string, (model: string) => ResolvedModel["model"]>>;
}): ModelRegistry {
  const { config, resolveSecret } = options;
  const fetchOption = options.fetch ? { fetch: options.fetch } : {};

  const build = async (alias: string, provider: ProviderConfig, model: string): Promise<LanguageModel> => {
    const contextWindow = provider.models[model]?.context_window;
    const apiKey = provider.api_key === undefined ? undefined : await resolveSecret(provider.api_key);
    const common = {
      ...(provider.base_url ? { baseURL: provider.base_url } : {}),
      ...(apiKey === undefined ? {} : { apiKey }),
      ...fetchOption,
    };
    switch (provider.type) {
      case "anthropic":
        return createAnthropic(common).languageModel(model);
      case "openai":
        return createOpenAI(common).languageModel(model);
      case "google":
        return createGoogle(common).languageModel(model);
      case "ollama":
        // ai-sdk-ollama wants the host URL; accept the common `.../api` form too.
        return createOllama({
          ...common,
          ...(provider.base_url ? { baseURL: provider.base_url.replace(/\/api\/?$/, "") } : {}),
        }).languageModel(
          model,
          // Ollama's default context is small; a declared context window is what the role checks rely on.
          contextWindow === undefined ? {} : { options: { num_ctx: contextWindow } },
        );
      case "openai-compatible":
        return createOpenAICompatible({
          name: alias,
          baseURL: provider.base_url ?? "",
          ...common,
        }).languageModel(model);
    }
  };

  const resolveRef = async (ref: ModelRef): Promise<ResolvedModel> => {
    const id = `${ref.provider}/${ref.model}`;
    const extra = options.extra?.[ref.provider];
    if (extra) {
      return {
        ref,
        id,
        model: extra(ref.model),
        profile: modelProfile(
          "mock",
          ref.model,
          config.providers[ref.provider]?.models[ref.model] ?? {
            tools: true,
            structured_output: true,
            vision: true,
            context_window: 200_000,
          },
        ),
      };
    }
    const provider = config.providers[ref.provider];
    if (!provider) {
      throw new ConfigError("MODEL_PROVIDER_UNKNOWN", `No provider '${ref.provider}' in models.providers.`, {
        provider: ref.provider,
        available: Object.keys(config.providers),
      });
    }
    return {
      ref,
      id,
      model: await build(ref.provider, provider, ref.model),
      profile: modelProfile(provider.type, ref.model, provider.models[ref.model]),
    };
  };

  return {
    resolve: (reference) => resolveRef(parseModelRef(reference)),
    forRole: (role) =>
      resolveRef(
        resolveRoleModel(
          config.roles,
          role,
          Object.entries(config.providers).flatMap(([alias, p]) =>
            Object.keys(p.models).map((m) => `${alias}/${m}`),
          ),
        ),
      ),
  };
}
