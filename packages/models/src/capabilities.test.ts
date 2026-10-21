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
    expect(modelProfile("openai", "gpt-5").costPerMTok).toBeUndefined();
    expect(modelProfile("openai-compatible", "anything").costPerMTok).toBeUndefined();
    expect(modelProfile("ollama", "qwen3:14b").costPerMTok).toEqual({ input: 0, output: 0 });
  });
});
