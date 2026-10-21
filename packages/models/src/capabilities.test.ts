import { describe, expect, it } from "vitest";
import { BUILT_IN_PROFILES_CHECKED, modelProfile } from "./capabilities.js";

describe("built-in model profiles (REQ-LLM-09/AC2, REQ-LLM-03)", () => {
  it.each([
    ["claude-opus-5-5", 1_000_000, 4, 20],
    ["claude-sonnet-5-5", 1_000_000, 2, 10],
    ["claude-fable-5-1", 1_000_000, 10, 50],
    // Haiku 5.5 costs more above 100k prompt tokens; the higher price keeps a budget on the safe side.
    ["claude-haiku-5-5", 1_000_000, 0.5, 2.5],
    ["claude-opus-5", 200_000, 5, 25],
    ["claude-sonnet-5", 200_000, 2, 10],
    ["claude-opus-4-5-20251101", 200_000, 5, 25],
    ["claude-sonnet-4-5-20250929", 200_000, 3, 15],
    ["claude-haiku-4-5-20251001", 200_000, 1, 5],
  ])(
    "REQ-LLM-09/AC2: %s has its context window and price per million tokens built in",
    (model, context, input, output) => {
      expect(modelProfile("anthropic", model)).toEqual({
        tools: true,
        structuredOutput: true,
        vision: true,
        contextWindow: context,
        costPerMTok: { input, output },
      });
    },
  );

  it("REQ-LLM-09/AC2: the profiles say when they were checked", () => {
    expect(BUILT_IN_PROFILES_CHECKED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("REQ-LLM-09/AC2+AC3: a declared value wins; an unknown cloud model has no price (unknown cost, never 0); local models cost nothing", () => {
    expect(
      modelProfile("anthropic", "claude-sonnet-5-5", { cost_per_mtok: { input: 1, output: 2 } }).costPerMTok,
    ).toEqual({ input: 1, output: 2 });
    expect(modelProfile("anthropic", "claude-sonnet-5-5", { context_window: 100_000 }).contextWindow).toBe(
      100_000,
    );
    expect(modelProfile("openai", "o4-mini").costPerMTok).toBeUndefined();
    expect(modelProfile("openai-compatible", "anything").costPerMTok).toBeUndefined();
    expect(modelProfile("ollama", "qwen3:14b").costPerMTok).toEqual({ input: 0, output: 0 });
  });
});

describe("built-in profiles of OpenAI and Google models (REQ-LLM-09/AC6)", () => {
  const mid2026 = new Date("2026-10-21T12:00:00Z");
  it.each([
    ["openai", "gpt-6-astra", 1_050_000, 10, 50],
    ["openai", "gpt-6.1-sol", 1_050_000, 2, 10],
    ["openai", "gpt-6-luna", 1_050_000, 0.1, 0.5],
    ["google", "gemini-4-argon", 1_000_000, 2, 10],
    ["google", "gemini-3.8-flash", 1_000_000, 0.75, 3.75],
  ])(
    "REQ-LLM-09/AC6: %s %s has its context window and price built in",
    (type, model, context, input, output) => {
      expect(modelProfile(type, model, {}, mid2026)).toEqual({
        tools: true,
        structuredOutput: true,
        vision: true,
        contextWindow: context,
        costPerMTok: { input, output },
      });
    },
  );

  it("REQ-LLM-09/AC6: an older model keeps its known price; a price that depends on prompt size takes the higher tier", () => {
    expect(modelProfile("openai", "gpt-4o", {}, mid2026).costPerMTok).toEqual({ input: 2.5, output: 10 });
    expect(modelProfile("openai", "gpt-5.4-mini", {}, mid2026).costPerMTok).toEqual({
      input: 0.75,
      output: 4.5,
    });
    expect(modelProfile("google", "gemini-2.5-pro", {}, mid2026).costPerMTok).toEqual({
      input: 2.5,
      output: 15,
    });
  });

  it("REQ-LLM-09/AC3+AC6: a price announced to rise is not used after the day it rises: the cost becomes unknown, never too low", () => {
    expect(
      modelProfile("google", "gemini-4-argon", {}, new Date("2026-12-31T23:00:00Z")).costPerMTok,
    ).toEqual({
      input: 2,
      output: 10,
    });
    expect(
      modelProfile("google", "gemini-4-argon", {}, new Date("2027-01-01T00:00:00Z")).costPerMTok,
    ).toBeUndefined();
    // A declared price is the project's own and does not expire.
    expect(
      modelProfile(
        "google",
        "gemini-4-argon",
        { cost_per_mtok: { input: 3, output: 12 } },
        new Date("2027-02-01T00:00:00Z"),
      ).costPerMTok,
    ).toEqual({ input: 3, output: 12 });
  });
});
