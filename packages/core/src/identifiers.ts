import { z } from "zod";

/**
 * Jira ticket key such as `SHOP-482`. Validated before it is used in file paths,
 * branch searches or Docker labels (REQ-CTX-01, REQ-NFR-05).
 */
export const TicketKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,19}-[1-9]\d{0,8}$/, "Expected a Jira key like SHOP-482")
  .brand<"TicketKey">();

/** Validated Jira ticket key. */
export type TicketKey = z.infer<typeof TicketKeySchema>;

/** Run identifier `YYYYMMDD-HHMM-xxxx` (UTC time plus 4 random base-36 characters; REQ-WS-01). */
export const RunIdSchema = z
  .string()
  .regex(/^\d{8}-\d{4}-[a-z0-9]{4}$/, "Expected a run id like 20261003-1046-k7f3")
  .brand<"RunId">();

/** Validated run identifier. */
export type RunId = z.infer<typeof RunIdSchema>;

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/**
 * Creates a new run identifier. Time and randomness are injected so tests are deterministic.
 *
 * @param now - Current time; the UTC date and time are used.
 * @param random - Function returning numbers in [0, 1), e.g. `Math.random`.
 * @returns A run id such as `20261003-1046-k7f3`.
 * @example
 * const runId = createRunId(new Date(), Math.random);
 */
export function createRunId(now: Date, random: () => number): RunId {
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (let i = 0; i < 4; i += 1) {
    const index = Math.min(alphabet.length - 1, Math.floor(random() * alphabet.length));
    suffix += alphabet.charAt(index);
  }
  return RunIdSchema.parse(`${date}-${time}-${suffix}`);
}
