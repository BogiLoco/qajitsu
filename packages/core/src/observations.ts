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
  readonly kind:
    | "openapi"
    | "console"
    | "http"
    | "accessibility"
    | "ui-contract"
    | "security"
    | "performance"
    | "network-change";
  readonly text: string;
}

/** Name of the per-attempt analysis of the page's traffic, written by the trusted parent (REQ-EVD-09). */
export const NETWORK_ANALYSIS_FILE = "network-analysis.json";

/** A request of the analysis: its method, masked URL and the index of its entry in the attempt's `network.har`. */
const AnalysedRequest = {
  stepId: z.string(),
  method: z.string(),
  url: z.string(),
  /** Index of the entry in `network.har` (REQ-EVD-09/AC7); absent when the HAR does not hold it. */
  har: z.number().int().min(0).optional(),
};

/**
 * Code's analysis of the traffic of a web attempt (REQ-EVD-09/AC3..AC7). Listed for people as observations; nothing
 * of it changes a status or a count (invariant 1, invariant 6).
 */
export const NetworkAnalysisSchema = z.strictObject({
  /** AC4: per step, the number and size of its requests, the slowest ones, and the budget it went over. */
  steps: z
    .array(
      z.strictObject({
        stepId: z.string(),
        requests: z.number().int().min(0),
        bytes: z.number().int().min(0),
        slowest: z.array(z.strictObject({ ...AnalysedRequest, durationMs: z.number().min(0) })).max(5),
        warnings: z.array(z.string().max(300)).max(10),
      }),
    )
    .default([]),
  /** AC6: tokens or personal data in URLs, mixed content, missing security headers, cookies without flags. */
  security: z
    .array(
      z.strictObject({
        ...AnalysedRequest,
        kind: z.enum([
          "secret-in-url",
          "personal-data-in-url",
          "mixed-content",
          "missing-header",
          "insecure-cookie",
        ]),
        detail: z.string().max(300),
      }),
    )
    .max(200)
    .default([]),
  /** AC3: responses the page received that do not match the API description, added by the runner. */
  contract: z
    .array(z.strictObject({ ...AnalysedRequest, status: z.number().int(), problem: z.string().max(500) }))
    .max(200)
    .default([]),
  /**
   * AC3: the masked, size-limited JSON bodies of the application's responses, only when the project enables them;
   * a body that still looks like it holds a secret is not kept.
   */
  bodies: z
    .array(z.strictObject({ ...AnalysedRequest, status: z.number().int(), body: z.unknown() }))
    .max(500)
    .default([]),
  /** AC5: the application's endpoints with their status and, with bodies, the shape of their answer. */
  endpoints: z
    .array(
      z.strictObject({
        method: z.string(),
        path: z.string(),
        status: z.number().int(),
        shape: z.string().max(2000).optional(),
      }),
    )
    .max(500)
    .default([]),
});

/** Parsed traffic analysis of a web attempt. */
export type NetworkAnalysis = z.infer<typeof NetworkAnalysisSchema>;

/** Limits of a step's traffic (REQ-EVD-09/AC4): going over one is a warning, never a status. */
export const NetworkBudgetSchema = z.strictObject({
  /** The slowest request of a step may take this long. */
  request_ms: z.number().int().min(1).max(600_000).optional(),
  /** A step may send this many requests. */
  step_requests: z.number().int().min(1).max(10_000).optional(),
  /** A step may receive this much. */
  step_kb: z.number().int().min(1).max(1_000_000).optional(),
});

/** Parsed network budget. */
export type NetworkBudget = z.infer<typeof NetworkBudgetSchema>;
