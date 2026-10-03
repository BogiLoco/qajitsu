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
  readonly cost_per_mtok?: { readonly input: number; readonly output: number } | undefined;
}

/**
 * Conservative built-in profiles by provider type and model-id pattern (REQ-LLM-03). Unknown local
 * models get no tools and no structured output, so they fail the capability check instead of
 * producing quietly broken plans; declare capabilities in config after checking with `doctor --models`.
 */
const BUILT_IN: readonly { readonly type: string; readonly match: RegExp; readonly profile: ModelProfile }[] =
  [
    {
      type: "anthropic",
      match: /^claude-.*haiku/,
      profile: { tools: true, structuredOutput: true, vision: true, contextWindow: 200_000 },
    },
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
      profile: { tools: true, structuredOutput: true, vision: false, contextWindow: 32_768 },
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
  const base = BUILT_IN.find((b) => b.type === providerType && b.match.test(model))?.profile ?? UNKNOWN;
  return {
    tools: override.tools ?? base.tools,
    structuredOutput: override.structured_output ?? base.structuredOutput,
    vision: override.vision ?? base.vision,
    contextWindow: override.context_window ?? base.contextWindow,
    costPerMTok: override.cost_per_mtok ?? base.costPerMTok,
  };
}
