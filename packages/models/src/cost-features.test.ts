import { describe, expect, it } from "vitest";
import { modelProfile } from "./capabilities.js";
import { cacheProviderOptions, chooseCacheTtl, estimateInputTokens, inputLimit } from "./cost-features.js";

describe("provider cost features (REQ-LLM-12)", () => {
  it("REQ-LLM-12/AC2: the cache duration follows how close together the project's model calls are", () => {
    const at = (minutes: number[]) => minutes.map((m) => m * 60_000);
    expect(chooseCacheTtl(at([0, 1, 2, 4, 5]))).toEqual({
      ttl: "5m",
      basis: "median gap 1 min between 5 recent model calls",
    });
    expect(chooseCacheTtl(at([0, 20, 45, 70]))).toEqual({
      ttl: "1h",
      basis: "median gap 25 min between 4 recent model calls",
    });
    expect(chooseCacheTtl(at([0, 300, 900]))).toMatchObject({
      ttl: "5m",
      basis: expect.stringContaining("too far apart") as unknown,
    });
    expect(chooseCacheTtl([])).toEqual({ ttl: "5m", basis: "no earlier model calls in this project" });
  });

  it("REQ-LLM-12/AC1+AC5: only Anthropic needs an explicit cache breakpoint; off sends nothing", () => {
    expect(cacheProviderOptions("anthropic", "5m")).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(cacheProviderOptions("anthropic", "1h")).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
    });
    expect(cacheProviderOptions("anthropic", "off")).toBeUndefined();
    expect(cacheProviderOptions("openai", "1h")).toBeUndefined();
    expect(cacheProviderOptions("google", "5m")).toBeUndefined();
  });

  it("REQ-LLM-12/AC4: the input of a call is estimated before sending; the limit is the lowest of window, price tier and project limit", () => {
    expect(estimateInputTokens(["abcd", "efgh"], 1)).toBe(2 + 1600);
    const pro = modelProfile("google", "gemini-2.5-pro");
    expect(pro.priceTierTokens).toBe(200_000);
    expect(inputLimit(pro)).toEqual({ limit: 200_000, why: "the model's price tier boundary" });
    expect(inputLimit(pro, 50_000)).toEqual({ limit: 50_000, why: "models.max_input_tokens" });
    expect(inputLimit(modelProfile("google", "gemini-2.5-flash"))).toEqual({
      limit: 1_000_000,
      why: "the model's context window",
    });
    expect(modelProfile("openai", "gpt-5", { price_tier_tokens: 100_000 }).priceTierTokens).toBe(100_000);
  });
});
