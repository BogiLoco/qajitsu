import { z } from "zod";

/**
 * Limits for a shared environment (REQ-EXEC-54), under `execution.rate_limit`: how fast QAJitsu may call one host,
 * how many cases may run at once across all lanes, how long a case may wait out `429` and `503`, and the header that
 * carries an idempotency key.
 */
export const RateLimitConfigSchema = z.strictObject({
  /** Requests per second to one host, across every lane of a run; unlimited when not set. */
  requests_per_second: z.number().min(0.1).max(1000).optional(),
  /** Cases running at the same time across every lane; the lanes' own workers when not set. */
  parallel_cases: z.number().int().min(1).max(64).optional(),
  /** How long one case may wait out `Retry-After` before it is BLOCKED as rate limited. */
  retry_budget_s: z.number().int().min(0).max(3600).default(30),
  /** The header of the idempotency key a plan step asks for. */
  idempotency_header: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/, "A header name")
    .default("Idempotency-Key"),
});

/** Parsed `execution.rate_limit`. */
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;

/** What a run shares across its lanes so a shared environment is not overloaded (REQ-EXEC-54). */
export interface TrafficPolicy {
  /** Waits until a request to the URL's host fits the rate (AC1). */
  readonly throttle: (url: string) => Promise<void>;
  /** Holds one of the run's case slots (AC1); call the returned function when the case ends. */
  readonly caseSlot: () => Promise<() => void>;
  /** How long one case may wait out `Retry-After` in total (AC2, AC3). */
  readonly retryBudgetMs: number;
  /** The header of an idempotency key (AC4). */
  readonly idempotencyHeader: string;
}

/**
 * The traffic policy of one run (REQ-EXEC-54/AC1): a token bucket per host at `requests_per_second` (a burst of one
 * second's worth), and at most `parallel_cases` cases at once. The clock and the sleep are injected.
 *
 * @param config - `execution.rate_limit`.
 * @param time - The clock and the wait.
 */
export function createTrafficPolicy(
  config: RateLimitConfig,
  time: { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> },
): TrafficPolicy {
  const rate = config.requests_per_second;
  const burst = rate === undefined ? 0 : Math.max(1, Math.floor(rate));
  /** Per host: when its next request may go, as a virtual schedule. */
  const next = new Map<string, number>();
  const sent = new Map<string, number>();
  const throttle = async (url: string): Promise<void> => {
    if (rate === undefined) return;
    const host = new URL(url).host;
    const interval = 1000 / rate;
    const count = (sent.get(host) ?? 0) + 1;
    sent.set(host, count);
    if (count <= burst) return;
    // Every request after the burst gets the next free slot of its host, whatever lane sends it.
    const at = Math.max(time.now(), next.get(host) ?? 0) + interval;
    next.set(host, at);
    const wait = at - time.now();
    if (wait > 0) await time.sleep(wait);
  };
  const limit = config.parallel_cases;
  let running = 0;
  const waiting: (() => void)[] = [];
  const caseSlot = async (): Promise<() => void> => {
    if (limit !== undefined) {
      while (running >= limit)
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
        });
      running += 1;
    }
    let released = false;
    return () => {
      if (released || limit === undefined) return;
      released = true;
      running -= 1;
      waiting.shift()?.();
    };
  };
  return {
    throttle,
    caseSlot,
    retryBudgetMs: config.retry_budget_s * 1000,
    idempotencyHeader: config.idempotency_header,
  };
}

/**
 * How long a `Retry-After` header asks to wait (REQ-EXEC-54/AC2): seconds, or an HTTP date relative to `now`; undefined
 * when absent or unreadable.
 *
 * @param headers - Response headers, any case.
 * @param now - Epoch ms.
 */
export function retryAfterMs(headers: Readonly<Record<string, string>>, now: number): number | undefined {
  const value = Object.entries(headers)
    .find(([k]) => k.toLowerCase() === "retry-after")?.[1]
    ?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) || !/[a-z]/i.test(value) ? undefined : Math.max(0, date - now);
}
