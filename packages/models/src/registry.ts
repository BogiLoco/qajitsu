import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { ConfigError, type ModelProvider, type ProjectConfig } from "@qajitsu/core";
import type { JSONValue, LanguageModel } from "ai";
import { createOllama } from "ai-sdk-ollama";
import { patientFetch } from "./patient-fetch.js";
import { hasBuiltInProfile, modelProfile, type ModelProfile } from "./capabilities.js";
import {
  memoryGatewayCache,
  profileWithSources,
  readGateway,
  type GatewayCache,
  type GatewayInfo,
  type ProfileSources,
} from "./gateway.js";
import { cacheProviderOptions, inputLimit, type CacheTtl } from "./cost-features.js";
import { contextProfile, type ContextProfile } from "./context-profile.js";
import { providerBatch, type ModelBatch } from "./batch.js";
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
  /** Where each capability of the profile came from (REQ-LLM-10/AC3); set for gateway providers. */
  readonly sources?: ProfileSources | undefined;
  /** When the gateway's answer behind the profile was read (REQ-LLM-10/AC3). */
  readonly gatewayReadAt?: string | undefined;
  /** The provider's batch API for work that is not time-critical (REQ-LLM-12/AC3); undefined without one. */
  readonly batch?: ModelBatch | undefined;
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
  /** Batch APIs of extra providers by alias (tests): their models can be batched like a provider's (REQ-LLM-12/AC3). */
  readonly extraBatches?: Readonly<Record<string, (model: string) => ModelBatch>>;
  /** The project's prompt cache duration, already chosen when `cache_ttl` is `auto` (REQ-LLM-12/AC2). */
  readonly cacheTtl?: CacheTtl;
  /**
   * A context policy for every model of the run (REQ-CTX-18/AC2, `qj bench --context`): its working range and style win
   * over the models' own.
   */
  readonly contextPolicy?: {
    readonly workingRange?: number | undefined;
    readonly style?: "full" | "compact" | undefined;
  };
  /** Keeps gateway answers between commands (REQ-LLM-10/AC3); one process's memory by default. */
  readonly gatewayCache?: GatewayCache;
  /** Told when a gateway does not answer and the profiles fall back to the config (REQ-LLM-10/AC4). */
  readonly onWarning?: (message: string) => void;
  readonly now?: () => Date;
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
        workingRange: options.contextPolicy?.workingRange ?? overrides.working_range,
        style: options.contextPolicy?.style ?? overrides.context_style,
        shares: config.context_shares as Readonly<Record<string, number>> | undefined,
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

  const build = async (
    alias: string,
    provider: ProviderConfig,
    model: string,
  ): Promise<{ readonly model: LanguageModel; readonly batch?: ModelBatch }> => {
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
      // REQ-LLM-12/AC3: these providers have a batch API; the others are called at once.
      case "anthropic": {
        const p = createAnthropic(common);
        return { model: p.languageModel(model), batch: providerBatch(p, model) };
      }
      case "openai": {
        const p = createOpenAI(common);
        return { model: p.languageModel(model), batch: providerBatch(p, model) };
      }
      case "google": {
        const p = createGoogle(common);
        return { model: p.languageModel(model), batch: providerBatch(p, model) };
      }
      case "ollama":
        // ai-sdk-ollama wants the host URL; accept the common `.../api` form too.
        return {
          model: createOllama({
            ...common,
            ...local,
            ...(provider.base_url ? { baseURL: provider.base_url.replace(/\/api\/?$/, "") } : {}),
          }).languageModel(model, {
            // Ollama's default context is small; a declared context window is what the role checks rely on.
            ...(contextWindow === undefined ? {} : { options: { num_ctx: contextWindow } }),
            // Reasoning models such as Qwen3 call tools only with an explicit thinking mode.
            ...(think === undefined ? {} : { think }),
          }),
        };
      case "openai-compatible":
        return {
          model: createOpenAICompatible({
            name: alias,
            baseURL: provider.base_url ?? "",
            ...common,
            ...local,
          }).languageModel(model),
        };
    }
  };

  const gatewayCache = options.gatewayCache ?? memoryGatewayCache();
  const gateways = new Map<string, Promise<GatewayInfo | undefined>>();
  /** REQ-LLM-10: a gateway's models, read once per provider; a gateway that does not answer is warned about. */
  const gatewayOf = (alias: string, provider: ProviderConfig): Promise<GatewayInfo | undefined> => {
    const kind = provider.gateway;
    if (kind === undefined || provider.base_url === undefined) return Promise.resolve(undefined);
    let found = gateways.get(alias);
    if (!found) {
      found = (async () => {
        const apiKey = provider.api_key === undefined ? undefined : await resolveSecret(provider.api_key);
        return readGateway(
          { alias, kind, baseUrl: provider.base_url ?? "", apiKey },
          {
            fetch: options.fetch ?? globalThis.fetch,
            cache: gatewayCache,
            now: options.now ?? (() => new Date()),
          },
        );
      })().catch((error: unknown) => {
        options.onWarning?.(
          `${error instanceof Error ? error.message : String(error)} Using the configured and built-in profiles.`,
        );
        return undefined;
      });
      gateways.set(alias, found);
    }
    return found;
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
          ...(options.extraBatches?.[ref.provider]
            ? { batch: options.extraBatches[ref.provider]?.(ref.model) }
            : {}),
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
    const gateway = await gatewayOf(ref.provider, provider);
    /** REQ-FLOW-06/AC7: a model served from this machine costs nothing, unless a price is declared. */
    const localZero = (profile: ModelProfile): ModelProfile =>
      profile.costPerMTok === undefined &&
      (profile.datedPrices ?? []).length === 0 &&
      // A gateway on this machine (LiteLLM, OpenRouter) forwards to paid providers: its prices come from it.
      provider.gateway === undefined &&
      provider.base_url !== undefined &&
      /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i.test(provider.base_url)
        ? { ...profile, costPerMTok: { input: 0, output: 0 } }
        : profile;
    const fromGateway =
      provider.gateway === undefined
        ? undefined
        : profileWithSources(
            modelProfile(provider.type, ref.model),
            hasBuiltInProfile(provider.type, ref.model),
            gateway?.models.get(ref.model),
            declared,
          );
    const built = await build(ref.provider, provider, ref.model);
    return withCostFeatures(
      provider.type,
      {
        ref,
        id,
        model: built.model,
        ...(built.batch ? { batch: built.batch } : {}),
        profile: localZero(
          fromGateway
            ? // Declared extras (prices by date, price tiers) still come from the config.
              { ...modelProfile(provider.type, ref.model, declared), ...fromGateway.profile }
            : modelProfile(provider.type, ref.model, declared),
        ),
        ...(fromGateway ? { sources: fromGateway.sources } : {}),
        ...(gateway ? { gatewayReadAt: gateway.readAt } : {}),
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
