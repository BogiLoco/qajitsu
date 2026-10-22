import { estimateInputTokens, type ResolvedModel } from "@qajitsu/models";
import type { ModelMessage, SystemModelMessage } from "ai";
import { AgentInputTooLargeError } from "./errors.js";

/** The parts of a model call that `prepareCall` arranges. */
export interface PreparedCall {
  /** The instructions, as a system message with provider options when they carry a cache breakpoint. */
  readonly system: string | SystemModelMessage;
  readonly messages: ModelMessage[];
}

const textsOf = (messages: readonly ModelMessage[]): { texts: string[]; images: number } => {
  const texts: string[] = [];
  let images = 0;
  for (const m of messages) {
    if (typeof m.content === "string") texts.push(m.content);
    else
      for (const part of m.content) {
        if (part.type === "text") texts.push(part.text);
        else if (part.type === "file" || part.type === "image") images += 1;
        else texts.push(JSON.stringify(part));
      }
  }
  return { texts, images };
};

/**
 * Prepares one model call (REQ-LLM-12): counts its input before sending and stops a call over the model's limit (its
 * context window, its price tier boundary or the project's limit) with the reason (AC4); for a provider that needs it,
 * marks the stable prefix (the system prompt and the first message with the ticket and repository context) as a cache
 * breakpoint, so repairs and later calls reuse it (AC1). Provider details stay in `@qajitsu/models` (AC5).
 *
 * @param model - The resolved model.
 * @param system - The role's instructions.
 * @param messages - The conversation so far.
 * @throws {AgentInputTooLargeError} `MODEL_INPUT_TOO_LARGE` with the estimate and the limit.
 */
export function prepareCall(
  model: ResolvedModel,
  system: string,
  messages: readonly ModelMessage[],
): PreparedCall {
  const { texts, images } = textsOf(messages);
  const estimate = estimateInputTokens([system, ...texts], images);
  if (model.inputLimit && estimate > model.inputLimit.limit)
    throw new AgentInputTooLargeError(
      "MODEL_INPUT_TOO_LARGE",
      `The call to ${model.id} would send about ${String(estimate)} input tokens, over ${String(model.inputLimit.limit)} (${model.inputLimit.why}); nothing was sent. Narrow the context or raise the limit.`,
      { model: model.id, estimate, limit: model.inputLimit.limit, why: model.inputLimit.why },
    );
  if (!model.cacheOptions) return { system, messages: [...messages] };
  const providerOptions = model.cacheOptions;
  const [first, ...rest] = messages;
  return {
    system: { role: "system" as const, content: system, providerOptions },
    messages: [...(first ? [{ ...first, providerOptions } as ModelMessage] : []), ...rest],
  };
}
