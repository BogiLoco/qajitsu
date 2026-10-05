import { z } from "zod";

/** Name of the per-attempt file with passive observations, written by the trusted parent (REQ-EVD-07). */
export const OBSERVATIONS_FILE = "observations.json";

/**
 * Passive observations of one attempt (REQ-EVD-07): computed by code while the planned steps ran, never by an
 * LLM. They are listed for people and never change a status or the counts (invariant 1).
 */
export const PassiveObservationsSchema = z.strictObject({
  /** Browser console errors and uncaught page errors (REQ-EVD-07/AC2). */
  console: z
    .array(
      z.strictObject({ level: z.enum(["error", "pageerror"]), text: z.string().max(2000), url: z.string() }),
    )
    .default([]),
  /** Network responses with status 4xx or 5xx (REQ-EVD-07/AC2). */
  http: z
    .array(
      z.strictObject({ method: z.string(), url: z.string(), status: z.number().int().min(400).max(599) }),
    )
    .default([]),
  /** axe-core violations per visited page (REQ-EVD-07/AC3). */
  accessibility: z
    .array(
      z.strictObject({
        rule: z.string(),
        impact: z.string().optional(),
        help: z.string().max(500),
        url: z.string(),
        targets: z.array(z.string().max(300)).max(5),
      }),
    )
    .default([]),
});

/** Parsed passive observations of an attempt. */
export type PassiveObservations = z.infer<typeof PassiveObservationsSchema>;

/** One line of the observations section of a report or Jira comment. */
export interface RunObservation {
  readonly caseId: string;
  readonly kind: "openapi" | "console" | "http" | "accessibility";
  readonly text: string;
}
