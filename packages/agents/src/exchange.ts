import { sha256, type ModelExchange } from "@qajitsu/core";
import type { ResolvedModel } from "@qajitsu/models";

/** What an agent sent with one `generateText` call. */
export interface ExchangeRequest {
  readonly system?: string | undefined;
  readonly prompt?: string | undefined;
  readonly messages?: readonly unknown[] | undefined;
}

/** The parts of a `generateText` result the transcript keeps. */
export interface ExchangeResult {
  readonly text: string;
  readonly usage: { readonly inputTokens?: number | undefined; readonly outputTokens?: number | undefined };
  readonly steps?: readonly {
    readonly toolCalls?: readonly { readonly toolName: string; readonly input?: unknown }[];
    readonly toolResults?: readonly { readonly toolName: string; readonly output?: unknown }[];
  }[];
  readonly response?: { readonly modelId?: string | undefined };
}

/** Binary parts (screenshots) are kept as their hash and size: the files themselves are evidence. */
const plain = (value: unknown): unknown => {
  if (value instanceof Uint8Array) return { sha256: sha256(value), bytes: value.byteLength };
  if (value instanceof URL) return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
};

/**
 * The transcript record of one model call (REQ-VER-16/AC2): the prompt and messages as sent, the answer, every tool
 * call with its arguments and result, the provider and model the provider reported, and the tokens.
 *
 * @param stage - Pipeline stage.
 * @param role - Agent role.
 * @param model - The resolved model.
 * @param request - System prompt and prompt or messages.
 * @param result - The `generateText` result.
 */
export function modelExchange(
  stage: string,
  role: string,
  model: ResolvedModel,
  request: ExchangeRequest,
  result: ExchangeResult,
): ModelExchange {
  const provider = typeof model.model === "object" ? model.model.provider : undefined;
  return {
    stage,
    role,
    model: model.id,
    ...(provider ? { provider } : {}),
    ...(result.response?.modelId ? { modelVersion: result.response.modelId } : {}),
    request: plain({
      ...(request.system === undefined ? {} : { system: request.system }),
      ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
      ...(request.messages === undefined ? {} : { messages: request.messages }),
    }),
    response: plain({
      text: result.text,
      steps: (result.steps ?? []).map((s) => ({
        toolCalls: (s.toolCalls ?? []).map((c) => ({ tool: c.toolName, input: c.input })),
        toolResults: (s.toolResults ?? []).map((r) => ({ tool: r.toolName, output: r.output })),
      })),
    }),
    usage: { inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 },
  };
}
