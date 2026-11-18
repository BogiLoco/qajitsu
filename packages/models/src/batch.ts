import {
  experimental_getBatchResults as getBatchResults,
  experimental_getBatchStatus as getBatchStatus,
  experimental_startBatch as startBatch,
  type Experimental_BatchProvider as BatchProvider,
  type LanguageModelUsage,
  type ModelMessage,
  type SystemModelMessage,
} from "ai";
import type { ModelProfile, TokenPrice } from "./capabilities.js";

/** One call put into a batch: an id of the caller's choosing, the system prompt and the messages. */
export interface BatchCall {
  readonly id: string;
  /** The system prompt, as text or as a message that carries the provider's cache marker. */
  readonly system: string | SystemModelMessage;
  readonly messages: readonly ModelMessage[];
  readonly maxOutputTokens?: number | undefined;
}

/** A submitted batch, as stored to collect it later (serializable). */
export interface BatchRef {
  readonly version: 2;
  readonly id: string;
  readonly provider: string;
}

/** Where a batch stands. */
export interface BatchState {
  readonly state: "pending" | "completed" | "failed";
  readonly counts?: {
    readonly total: number;
    readonly pending: number;
    readonly completed: number;
    readonly failed: number;
  };
  readonly error?: string | undefined;
  readonly expiresAt?: string | undefined;
}

/** The answer to one call of a finished batch. */
export type BatchAnswer =
  | {
      readonly id: string;
      readonly status: "succeeded";
      readonly text: string;
      readonly usage: LanguageModelUsage;
    }
  | { readonly id: string; readonly status: "failed" | "cancelled" | "expired"; readonly error: string };

/**
 * A model's provider batch API (REQ-LLM-12/AC3): calls that are not time-critical, answered within the provider's
 * window (usually minutes, at most 24 hours) at its batch price.
 */
export interface ModelBatch {
  /** What a batched call costs against the model's price (0.5: half price). */
  readonly priceFactor: number;
  submit(
    calls: readonly BatchCall[],
    signal?: AbortSignal,
  ): Promise<BatchRef & { readonly expiresAt?: string | undefined }>;
  status(ref: BatchRef, signal?: AbortSignal): Promise<BatchState>;
  /** The answers of a batch that is no longer pending. */
  answers(ref: BatchRef, signal?: AbortSignal): Promise<BatchAnswer[]>;
}

/** Provider batch prices against their standard ones: Anthropic, OpenAI and Google charge half. */
const PRICE_FACTOR = 0.5;

const reason = (e: { readonly message: string; readonly code?: string | undefined } | undefined): string =>
  e === undefined ? "no reason given" : `${e.code ? `${e.code}: ` : ""}${e.message}`.slice(0, 300);

/**
 * The batch of one model of a provider that has a batch API.
 *
 * @param provider - The AI SDK provider instance (it implements `experimental_batch()`).
 * @param modelId - The provider's model id.
 */
export function providerBatch(provider: BatchProvider, modelId: string): ModelBatch {
  return {
    priceFactor: PRICE_FACTOR,
    async submit(calls, signal) {
      const started = await startBatch({
        provider,
        requests: calls.map((c) => ({
          id: c.id,
          type: "text" as const,
          model: modelId,
          system: c.system,
          messages: [...c.messages],
          ...(c.maxOutputTokens === undefined ? {} : { maxOutputTokens: c.maxOutputTokens }),
        })),
        ...(signal ? { abortSignal: signal } : {}),
      });
      return {
        version: 2,
        id: started.id,
        provider: started.provider,
        ...(started.expiresAt ? { expiresAt: started.expiresAt } : {}),
      };
    },
    async status(ref, signal) {
      const s = await getBatchStatus({ provider, batch: ref, ...(signal ? { abortSignal: signal } : {}) });
      return {
        state: s.status,
        ...(s.requestCounts ? { counts: { ...s.requestCounts } } : {}),
        ...(s.error ? { error: reason(s.error) } : {}),
        ...(s.expiresAt ? { expiresAt: s.expiresAt } : {}),
      };
    },
    async answers(ref, signal) {
      const out: BatchAnswer[] = [];
      for await (const item of getBatchResults({
        provider,
        batch: ref,
        ...(signal ? { abortSignal: signal } : {}),
      })) {
        if (item.type !== "text") continue;
        out.push(
          item.status === "succeeded"
            ? { id: item.id, status: "succeeded", text: item.text, usage: item.usage }
            : { id: item.id, status: item.status, error: reason(item.error) },
        );
      }
      return out;
    },
  };
}

/**
 * A model's profile at its batch price (REQ-LLM-12/AC3): every price, dated ones included, times the batch's factor.
 * A model without a price stays without one: a missing price is never turned into a cheap one.
 *
 * @param profile - The model's profile.
 * @param factor - {@link ModelBatch.priceFactor}.
 */
export function atBatchPrice(profile: ModelProfile, factor: number): ModelProfile {
  const scale = <P extends TokenPrice>(p: P): P => ({
    ...p,
    input: p.input * factor,
    output: p.output * factor,
    ...(p.cachedInput === undefined ? {} : { cachedInput: p.cachedInput * factor }),
    ...(p.cacheWrite === undefined ? {} : { cacheWrite: p.cacheWrite * factor }),
  });
  return {
    ...profile,
    ...(profile.costPerMTok ? { costPerMTok: scale(profile.costPerMTok) } : {}),
    ...(profile.datedPrices ? { datedPrices: profile.datedPrices.map(scale) } : {}),
  };
}
