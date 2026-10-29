import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { ConfigError, type ModelProvider, type ProjectConfig } from "@qajitsu/core";
import type { JSONValue, LanguageModel } from "ai";
import { createOllama } from "ai-sdk-ollama";
import { patientFetch } from "./patient-fetch.js";
import { modelProfile, type ModelProfile } from "./capabilities.js";
import { cacheProviderOptions, inputLimit, type CacheTtl } from "./cost-features.js";
import { contextProfile, type ContextProfile } from "./context-profile.js";
import { parseModelRef, resolveRoleModel, type ModelRef, type ModelRole } from "./model-ref.js";

/** A resolved model: AI SDK handle plus its capability profile. */
export interface ResolvedModel {
  readonly ref: ModelRef;
  /** `<provider>/<model>` as configured. */
  readonly id: string;
  readonly model: LanguageModel;
  readonly profile: ModelProfile;
  /** Provider options that mark a prompt cache breakpoint, when the provider needs them (REQ-LLM-12/AC1). */
  readonly cacheOptions?: Record<string, Record<string, JSONValue>> | undefined;
  /** Most input tokens one call may send and why (REQ-LLM-12/AC4). */
  readonly inputLimit?: { readonly limit: number; readonly why: string } | undefined;
  /** How the context manager plans this model's calls (REQ-LLM-15). */
  readonly context: ContextProfile;
  /**
   * Counts the input of a call with the provider's own counter (REQ-LLM-15/AC2), where it has one; asked only near
   * the budget, so most calls cost nothing extra.
   */
  readonly countTokens?: ((system: string, prompt: string) => Promise<number>) | undefined;
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
  /** The project's prompt cache duration, already chosen when `cache_ttl` is `auto` (REQ-LLM-12/AC2). */
  readonly cacheTtl?: CacheTtl;
}): ModelRegistry {
  const { config, resolveSecret } = options;
  /** REQ-LLM-12: the cache breakpoint and the input limit go with the model, so agents need not know the provider. */
  const withCostFeatures = (
    providerType: string,
    m: Omit<ResolvedModel, "context">,
    overrides: {
      readonly working_range?: number | undefined;
      readonly context_style?: "full" | "compact" | undefined;
    } = {},
  ): ResolvedModel => {
    const cacheOptions = cacheProviderOptions(providerType, options.cacheTtl ?? "off");
    return {
      ...m,
      ...(cacheOptions ? { cacheOptions } : {}),
      inputLimit: inputLimit(m.profile, config.max_input_tokens),
      // REQ-LLM-15: the provider type's defaults, the model's window and the project's overrides.
      context: contextProfile(providerType, m.profile, {
        workingRange: overrides.working_range,
        style: overrides.context_style,
      }),
    };
  };
  const fetchOption = options.fetch ? { fetch: options.fetch } : {};
  /** Anthropic's token counting endpoint (REQ-LLM-15/AC2): the same request shape as a message, nothing generated. */
  const anthropicCounter = async (provider: ProviderConfig, model: string) => {
    const apiKey = provider.api_key === undefined ? undefined : await resolveSecret(provider.api_key);
    const base = (provider.base_url ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
    const doFetch = options.fetch ?? globalThis.fetch;
    return async (system: string, prompt: string): Promise<number> => {
      const res = await doFetch(`${base}/messages/count_tokens`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...(apiKey === undefined ? {} : { "x-api-key": apiKey }),
        },
        body: JSON.stringify({ model, system, messages: [{ role: "user", content: prompt }] }),
      });
      if (!res.ok)
        throw new ConfigError("MODEL_COUNT_FAILED", `Token counting answered HTTP ${String(res.status)}.`, {
          model,
        });
      const body = (await res.json()) as { input_tokens?: unknown };
      if (typeof body.input_tokens !== "number")
        throw new ConfigError("MODEL_COUNT_FAILED", "Token counting returned no count.", { model });
      return body.input_tokens;
    };
  };

  const build = async (alias: string, provider: ProviderConfig, model: string): Promise<LanguageModel> => {
    const contextWindow = provider.models[model]?.context_window;
    const think = provider.models[model]?.think;
    const apiKey = provider.api_key === undefined ? undefined : await resolveSecret(provider.api_key);
    const common = {
      ...(provider.base_url ? { baseURL: provider.base_url } : {}),
      ...(apiKey === undefined ? {} : { apiKey }),
      ...fetchOption,
    };
    // REQ-LLM-01/AC7: local and self-hosted models wait as long as `timeout_s`, not the HTTP client's 5 minutes.
    const local = options.fetch ? {} : { fetch: patientFetch((provider.timeout_s ?? 1800) * 1000) };
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
          ...local,
          ...(provider.base_url ? { baseURL: provider.base_url.replace(/\/api\/?$/, "") } : {}),
        }).languageModel(model, {
          // Ollama's default context is small; a declared context window is what the role checks rely on.
          ...(contextWindow === undefined ? {} : { options: { num_ctx: contextWindow } }),
          // Reasoning models such as Qwen3 call tools only with an explicit thinking mode.
          ...(think === undefined ? {} : { think }),
        });
      case "openai-compatible":
        return createOpenAICompatible({
          name: alias,
          baseURL: provider.base_url ?? "",
          ...common,
          ...local,
        }).languageModel(model);
    }
  };

  const resolveRef = async (ref: ModelRef): Promise<ResolvedModel> => {
    const id = `${ref.provider}/${ref.model}`;
    const extra = options.extra?.[ref.provider];
    if (extra) {
      return withCostFeatures(
        "mock",
        {
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
        },
        config.providers[ref.provider]?.models[ref.model] ?? {},
      );
    }
    const provider = config.providers[ref.provider];
    if (!provider) {
      throw new ConfigError("MODEL_PROVIDER_UNKNOWN", `No provider '${ref.provider}' in models.providers.`, {
        provider: ref.provider,
        available: Object.keys(config.providers),
      });
    }
    const declared = provider.models[ref.model];
    return withCostFeatures(
      provider.type,
      {
        ref,
        id,
        model: await build(ref.provider, provider, ref.model),
        profile: modelProfile(provider.type, ref.model, declared),
        ...(provider.type === "anthropic"
          ? { countTokens: await anthropicCounter(provider, ref.model) }
          : {}),
      },
      declared ?? {},
    );
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
