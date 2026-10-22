import type { JSONValue } from "ai";
import type { ModelProfile } from "./capabilities.js";

/** How long a provider keeps a cached prompt prefix (REQ-LLM-12/AC2). */
export type CacheTtl = "5m" | "1h" | "off";

/**
 * Chooses the prompt cache duration of a project from when its model calls happened (REQ-LLM-12/AC2): when calls
 * usually follow each other within five minutes (repairs, cases of one run), the short cache; within an hour, the
 * long one, which costs more to write and pays off only then; otherwise the short one, which still serves the repairs
 * inside a stage.
 *
 * @param callTimesMs - Times of recent model calls of the project.
 * @returns The duration and the reason, to be recorded.
 */
export function chooseCacheTtl(callTimesMs: readonly number[]): { ttl: "5m" | "1h"; basis: string } {
  const times = [...callTimesMs].sort((a, b) => a - b);
  const gaps = times.slice(1).map((t, i) => t - (times[i] ?? t));
  if (gaps.length === 0) return { ttl: "5m", basis: "no earlier model calls in this project" };
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const minutes = Math.round(median / 6000) / 10;
  const basis = `median gap ${String(minutes)} min between ${String(times.length)} recent model calls`;
  if (median <= 5 * 60_000) return { ttl: "5m", basis };
  if (median <= 60 * 60_000) return { ttl: "1h", basis };
  return { ttl: "5m", basis: `${basis}; too far apart for the long cache` };
}

/**
 * Provider options that mark a cache breakpoint (REQ-LLM-12/AC1+AC5): Anthropic needs it explicitly; OpenAI and
 * Google cache a stable prompt prefix by themselves, so they get nothing.
 *
 * @param providerType - The provider's type.
 * @param ttl - The project's cache duration.
 */
export function cacheProviderOptions(
  providerType: string,
  ttl: CacheTtl,
): Record<string, Record<string, JSONValue>> | undefined {
  if (ttl === "off" || providerType !== "anthropic") return undefined;
  return {
    anthropic: { cacheControl: ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" } },
  };
}

/**
 * A conservative estimate of the input tokens of a call, before it is sent (REQ-LLM-12/AC4): one token per four
 * characters, and a fixed amount per image.
 *
 * @param texts - System prompt and message texts.
 * @param images - Number of images.
 */
export function estimateInputTokens(texts: readonly string[], images = 0): number {
  return Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 4) + images * 1600;
}

/**
 * The most input a call may send (REQ-LLM-12/AC4): the model's context window, its price tier boundary when its price
 * rises above a prompt size, and the project's limit per call, whichever is lowest, with why.
 *
 * @param profile - The model's profile.
 * @param maxInputTokens - `models.max_input_tokens` of the project.
 */
export function inputLimit(
  profile: ModelProfile,
  maxInputTokens?: number,
): { readonly limit: number; readonly why: string } {
  const limits: { limit: number; why: string }[] = [
    { limit: profile.contextWindow, why: "the model's context window" },
    ...(profile.priceTierTokens === undefined
      ? []
      : [{ limit: profile.priceTierTokens, why: "the model's price tier boundary" }]),
    ...(maxInputTokens === undefined ? [] : [{ limit: maxInputTokens, why: "models.max_input_tokens" }]),
  ];
  return limits.reduce((a, b) => (b.limit < a.limit ? b : a));
}
