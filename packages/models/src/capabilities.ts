import type { ModelCapabilities } from "@qajitsu/core";

/** USD per million tokens; cache reads and writes are charged as input when they have no price of their own. */
export interface TokenPrice {
  readonly input: number;
  readonly output: number;
  readonly cachedInput?: number | undefined;
  readonly cacheWrite?: number | undefined;
}

/** A capability profile plus optional pricing (USD per million tokens) for cost estimates (REQ-LLM-07). */
export interface ModelProfile extends ModelCapabilities {
  readonly costPerMTok?: TokenPrice | undefined;
  /** Prices with the day they apply from, oldest first (REQ-LLM-11/AC3). */
  readonly datedPrices?: readonly (TokenPrice & { readonly from: string })[] | undefined;
}

/**
 * The price of a model on a day (REQ-LLM-11/AC3): the latest dated price whose `from` is not after the day, else the
 * profile's price.
 *
 * @param profile - The model's profile.
 * @param day - The day of the call.
 */
export function priceOn(profile: ModelProfile, day: Date): TokenPrice | undefined {
  const date = day.toISOString().slice(0, 10);
  const dated = (profile.datedPrices ?? []).filter((p) => p.from <= date).at(-1);
  return dated ?? profile.costPerMTok;
}

/** Converts a price from the project config to a {@link TokenPrice}. */
const fromConfig = (p: {
  readonly input: number;
  readonly output: number;
  readonly cached_input?: number | undefined;
  readonly cache_write?: number | undefined;
}): TokenPrice => ({
  input: p.input,
  output: p.output,
  ...(p.cached_input === undefined ? {} : { cachedInput: p.cached_input }),
  ...(p.cache_write === undefined ? {} : { cacheWrite: p.cache_write }),
});

/** Declared overrides from `models.providers.<alias>.models.<model>` in `.qa/qa.project.yaml`. */
export interface CapabilityOverride {
  readonly tools?: boolean | undefined;
  readonly structured_output?: boolean | undefined;
  readonly vision?: boolean | undefined;
  readonly context_window?: number | undefined;
  /** Thinking mode sent to Ollama for reasoning models. */
  readonly think?: boolean | undefined;
  readonly cost_per_mtok?:
    | {
        readonly input: number;
        readonly output: number;
        readonly cached_input?: number | undefined;
        readonly cache_write?: number | undefined;
      }
    | undefined;
  readonly prices?:
    | readonly {
        readonly from: string;
        readonly input: number;
        readonly output: number;
        readonly cached_input?: number | undefined;
        readonly cache_write?: number | undefined;
      }[]
    | undefined;
}

/** When the built-in context windows and prices were last checked against the providers' pages (REQ-LLM-09/AC2). */
export const BUILT_IN_PROFILES_CHECKED = "2026-10-21";

const claude = (contextWindow: number, input: number, output: number): ModelProfile => ({
  tools: true,
  structuredOutput: true,
  vision: true,
  contextWindow,
  costPerMTok: { input, output },
});

/**
 * Conservative built-in profiles by provider type and model-id pattern (REQ-LLM-03), the first match wins. Unknown
 * local models get no tools and no structured output, so they fail the capability check instead of producing quietly
 * broken plans; declare capabilities in config after checking with `doctor --models`.
 *
 * Claude prices are the base input and output prices per million tokens from Anthropic's pricing page, checked on
 * {@link BUILT_IN_PROFILES_CHECKED} (REQ-LLM-09/AC2); Haiku 5.5 uses its price for prompts over 100k tokens, so a budget
 * errs on the safe side. Other cloud models have no built-in price: their cost is unknown until `cost_per_mtok` is
 * declared. Local models through Ollama cost nothing.
 */
/** An exact model id, optionally with a dated snapshot suffix (`gpt-4o-2024-08-06`). */
const exact = (id: string): RegExp =>
  new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-\\d{4}-\\d{2}-\\d{2})?$`);

/** A capable cloud model: tools, structured output, vision. */
const cloud = (contextWindow: number, input: number, output: number): ModelProfile => ({
  tools: true,
  structuredOutput: true,
  vision: true,
  contextWindow,
  costPerMTok: { input, output },
});

/**
 * OpenAI models (REQ-LLM-09/AC6): standard prices from OpenAI's pricing page; context windows from its models page
 * where it states them (the GPT-6 line, 1.05M tokens), otherwise the conservative 128k of the generic entry below.
 */
const OPENAI: readonly [string, number, number, number][] = [
  ["gpt-6-astra", 1_050_000, 10, 50],
  ["gpt-6.1-sol", 1_050_000, 2, 10],
  ["gpt-6-luna", 1_050_000, 0.1, 0.5],
  ["gpt-6-sol", 128_000, 2, 10],
  ["gpt-5.6-sol", 128_000, 4, 20],
  ["gpt-5.6-terra", 128_000, 2, 12],
  ["gpt-5.6-luna", 128_000, 0.2, 1.2],
  ["gpt-5.5-pro", 128_000, 30, 180],
  ["gpt-5.5", 128_000, 5, 30],
  ["gpt-5.4-pro", 128_000, 30, 180],
  ["gpt-5.4-mini", 128_000, 0.75, 4.5],
  ["gpt-5.4-nano", 128_000, 0.2, 1.25],
  ["gpt-5.4", 128_000, 2.5, 15],
  ["gpt-5.2-pro", 128_000, 21, 168],
  ["gpt-5.2", 128_000, 1.75, 14],
  ["gpt-5.1", 128_000, 1.25, 10],
  ["gpt-5-pro", 128_000, 15, 120],
  ["gpt-5-mini", 128_000, 0.25, 2],
  ["gpt-5-nano", 128_000, 0.05, 0.4],
  ["gpt-5", 128_000, 1.25, 10],
  ["gpt-4.1-mini", 128_000, 0.4, 1.6],
  ["gpt-4.1-nano", 128_000, 0.1, 0.4],
  ["gpt-4.1", 128_000, 2, 8],
  ["gpt-4o-mini", 128_000, 0.15, 0.6],
  ["gpt-4o", 128_000, 2.5, 10],
];

/**
 * Google models (REQ-LLM-09/AC6): standard prices from the Gemini API pricing page; a price that depends on the
 * prompt size takes its higher tier. Gemini 4 Argon and the 3.6 and 3.8 Flash prices hold through 2026-12-31 and rise
 * after it by an amount not published yet, so after that day their cost is unknown instead of too low.
 */
const GOOGLE: readonly [string, number, number, string?][] = [
  ["gemini-4-argon", 2, 10, "2026-12-31"],
  ["gemini-3.8-flash", 0.75, 3.75, "2026-12-31"],
  ["gemini-3.6-flash", 0.75, 3.75, "2026-12-31"],
  ["gemini-3.5-flash-lite", 0.3, 2.5],
  ["gemini-3.1-flash-lite", 0.25, 1.5],
  ["gemini-3.1-pro-preview", 4, 18],
  ["gemini-2.5-pro", 2.5, 15],
  ["gemini-2.5-flash-lite", 0.1, 0.4],
  ["gemini-2.5-flash", 0.3, 2.5],
];

const BUILT_IN: readonly {
  readonly type: string;
  readonly match: RegExp;
  readonly profile: ModelProfile;
  /** Last day the built-in price holds; after it the cost is unknown. */
  readonly priceUntil?: string;
}[] = [
  ...OPENAI.map(([id, context, input, output]) => ({
    type: "openai",
    match: exact(id),
    profile: cloud(context, input, output),
  })),
  ...GOOGLE.map(([id, input, output, until]) => ({
    type: "google",
    match: exact(id),
    profile: cloud(1_000_000, input, output),
    ...(until ? { priceUntil: until } : {}),
  })),
  { type: "anthropic", match: /^claude-(fable|mythos)-5-1\b/, profile: claude(1_000_000, 10, 50) },
  { type: "anthropic", match: /^claude-opus-5-5\b/, profile: claude(1_000_000, 4, 20) },
  { type: "anthropic", match: /^claude-sonnet-5-5\b/, profile: claude(1_000_000, 2, 10) },
  { type: "anthropic", match: /^claude-haiku-5-5\b/, profile: claude(1_000_000, 0.5, 2.5) },
  { type: "anthropic", match: /^claude-(fable|mythos)-5\b/, profile: claude(200_000, 10, 50) },
  { type: "anthropic", match: /^claude-opus-(5|4-[5-8])\b/, profile: claude(200_000, 5, 25) },
  { type: "anthropic", match: /^claude-opus-4(-1)?\b/, profile: claude(200_000, 15, 75) },
  { type: "anthropic", match: /^claude-sonnet-5\b/, profile: claude(200_000, 2, 10) },
  { type: "anthropic", match: /^claude-sonnet-4(-[56])?\b/, profile: claude(200_000, 3, 15) },
  { type: "anthropic", match: /^claude-haiku-4-5\b/, profile: claude(200_000, 1, 5) },
  {
    type: "anthropic",
    match: /^claude-/,
    profile: { tools: true, structuredOutput: true, vision: true, contextWindow: 200_000 },
  },
  {
    type: "openai",
    match: /^(gpt-4o|gpt-4\.1|gpt-5|o[34])/,
    profile: { tools: true, structuredOutput: true, vision: true, contextWindow: 128_000 },
  },
  {
    type: "google",
    match: /^gemini-/,
    profile: { tools: true, structuredOutput: true, vision: true, contextWindow: 1_000_000 },
  },
  {
    type: "ollama",
    match: /^(qwen3|qwen2\.5|llama3\.[1-3]|mistral|gemma[34]|gpt-oss)/,
    profile: {
      tools: true,
      structuredOutput: true,
      vision: false,
      contextWindow: 32_768,
      costPerMTok: { input: 0, output: 0 },
    },
  },
];

const UNKNOWN: ModelProfile = { tools: false, structuredOutput: false, vision: false, contextWindow: 8_192 };

/**
 * Returns the capability profile of a model: built-in profile, then config overrides.
 *
 * @param providerType - Provider type, e.g. `anthropic`, `ollama`.
 * @param model - Model id.
 * @param override - Declared capabilities from config.
 * @param now - Today, for built-in prices with an end date.
 */
export function modelProfile(
  providerType: string,
  model: string,
  override: CapabilityOverride = {},
  now: Date = new Date(),
): ModelProfile {
  const entry = BUILT_IN.find((b) => b.type === providerType && b.match.test(model));
  const expired = entry?.priceUntil !== undefined && now.toISOString().slice(0, 10) > entry.priceUntil;
  const found = entry && expired ? { ...entry.profile, costPerMTok: undefined } : entry?.profile;
  const base =
    found ??
    // A local model costs nothing even when its capabilities are unknown.
    (providerType === "ollama" ? { ...UNKNOWN, costPerMTok: { input: 0, output: 0 } } : UNKNOWN);
  return {
    tools: override.tools ?? base.tools,
    structuredOutput: override.structured_output ?? base.structuredOutput,
    vision: override.vision ?? base.vision,
    contextWindow: override.context_window ?? base.contextWindow,
    costPerMTok: override.cost_per_mtok ? fromConfig(override.cost_per_mtok) : base.costPerMTok,
    ...(override.prices && override.prices.length > 0
      ? {
          datedPrices: [...override.prices]
            .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
            .map((p) => ({ from: p.from, ...fromConfig(p) })),
        }
      : {}),
  };
}
