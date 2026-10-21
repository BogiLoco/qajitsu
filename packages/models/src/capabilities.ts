import type { ModelCapabilities } from "@qajitsu/core";

/** A capability profile plus optional pricing (USD per million tokens) for cost estimates (REQ-LLM-07). */
export interface ModelProfile extends ModelCapabilities {
  readonly costPerMTok?: { readonly input: number; readonly output: number } | undefined;
}

/** Declared overrides from `models.providers.<alias>.models.<model>` in `.qa/qa.project.yaml`. */
export interface CapabilityOverride {
  readonly tools?: boolean | undefined;
  readonly structured_output?: boolean | undefined;
  readonly vision?: boolean | undefined;
  readonly context_window?: number | undefined;
  /** Thinking mode sent to Ollama for reasoning models. */
  readonly think?: boolean | undefined;
  readonly cost_per_mtok?: { readonly input: number; readonly output: number } | undefined;
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
const BUILT_IN: readonly { readonly type: string; readonly match: RegExp; readonly profile: ModelProfile }[] =
  [
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
 */
export function modelProfile(
  providerType: string,
  model: string,
  override: CapabilityOverride = {},
): ModelProfile {
  const base =
    BUILT_IN.find((b) => b.type === providerType && b.match.test(model))?.profile ??
    // A local model costs nothing even when its capabilities are unknown.
    (providerType === "ollama" ? { ...UNKNOWN, costPerMTok: { input: 0, output: 0 } } : UNKNOWN);
  return {
    tools: override.tools ?? base.tools,
    structuredOutput: override.structured_output ?? base.structuredOutput,
    vision: override.vision ?? base.vision,
    contextWindow: override.context_window ?? base.contextWindow,
    costPerMTok: override.cost_per_mtok ?? base.costPerMTok,
  };
}
