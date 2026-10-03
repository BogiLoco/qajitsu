import type { ModelProfile, ResolvedModel } from "@qajitsu/models";
import { MockLanguageModelV4 } from "ai/test";

/** One scripted model turn: a text answer or tool calls. */
export type Turn =
  | { readonly text: string }
  | { readonly tools: readonly { readonly name: string; readonly input: unknown }[] };

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

/**
 * A deterministic model that plays a script of turns (no network, no real LLM; testing rules).
 * Each turn reports 100 input and 20 output tokens.
 */
export function scriptedModel(
  turns: readonly Turn[],
  profile: Partial<ModelProfile> = {},
): ResolvedModel & { mock: MockLanguageModelV4 } {
  let i = 0;
  const mock = new MockLanguageModelV4({
    doGenerate: () => {
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      if (!turn) throw new Error("empty script");
      if ("text" in turn) {
        return Promise.resolve({
          content: [{ type: "text", text: turn.text }],
          finishReason: { unified: "stop", raw: undefined },
          usage: usage(100, 20),
          warnings: [],
        });
      }
      return Promise.resolve({
        content: turn.tools.map((t, n) => ({
          type: "tool-call" as const,
          toolCallId: `call-${String(i)}-${String(n)}`,
          toolName: t.name,
          input: JSON.stringify(t.input),
        })),
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: usage(100, 20),
        warnings: [],
      });
    },
  });
  return {
    mock,
    ref: { provider: "mock", model: "scripted" },
    id: "mock/scripted",
    model: mock,
    profile: { tools: true, structuredOutput: true, vision: true, contextWindow: 200_000, ...profile },
  };
}

/** Text of every user/tool message the model received in call `n`. */
export function promptOf(model: { mock: MockLanguageModelV4 }, n: number): string {
  return JSON.stringify(model.mock.doGenerateCalls[n]?.prompt ?? []);
}
