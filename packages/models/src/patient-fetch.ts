import { Agent, fetch as undiciFetch } from "undici";

/**
 * A fetch that waits as long as a model needs (REQ-LLM-01/AC7). Node's built-in fetch gives up when no response
 * headers arrive within 5 minutes; Ollama answers without streaming only once the whole reply is generated, which a
 * thinking model that first loads into memory easily exceeds. Cancellation still works through the request's
 * AbortSignal (time box, stage stop).
 *
 * @param timeoutMs - Longest wait for the first byte and between body chunks.
 * @returns A fetch for the AI SDK providers.
 */
export function patientFetch(timeoutMs: number): typeof globalThis.fetch {
  const dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  return (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
    undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      { ...init, dispatcher } as Parameters<typeof undiciFetch>[1],
    );
}
