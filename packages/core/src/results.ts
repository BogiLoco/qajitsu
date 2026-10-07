import { z } from "zod";

/** One assertion recorded by `verify()` (REQ-EXEC-02/AC2). */
export const AssertionRecordSchema = z.strictObject({
  stepId: z.string(),
  field: z.string(),
  expected: z.unknown(),
  actual: z.unknown(),
  pass: z.boolean(),
  /** `manual`: the outcome of a manual step, reported by a person (REQ-EXEC-11/AC3, ADR-0008). */
  source: z.literal("manual").optional(),
  /** Who reported a manual outcome and when. */
  by: z.string().optional(),
  at: z.string().optional(),
  note: z.string().optional(),
  /** Passed but needs a person (REQ-EXEC-12/AC3): the case is NEEDS_REVIEW, never PASSED. */
  review: z.boolean().optional(),
});

/** One attempt of a case as stored in `results/<case>.json` (REQ-VER-02, REQ-EXEC-08/AC3). */
export const CaseAttemptSchema = z.strictObject({
  attempt: z.number().int().positive(),
  outcome: z.enum(["passed", "failed", "error", "skipped"]),
  assertions: z.array(AssertionRecordSchema),
  error: z.string().optional(),
  steps: z
    .array(
      z.strictObject({
        id: z.string(),
        ok: z.boolean(),
        error: z.string().optional(),
        url: z.string().optional(),
      }),
    )
    .default([]),
  /** Evidence paths (relative to `evidence/`) written for this attempt. */
  evidence: z.array(z.string()).default([]),
  /** SHA-256 of the spec file this attempt executed, recorded by the runner (REQ-PUB-08/AC2). */
  specSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  startedAt: z.string().optional(),
  /** The attempt ran a spec changed by the healer (REQ-EXEC-09). */
  healed: z.boolean().optional(),
  durationMs: z.number().nonnegative().optional(),
});

/** Schema of `results/<case>.json`, written only by runners (invariant 2). */
export const CaseResultFileSchema = z.strictObject({
  schema: z.literal(1),
  caseId: z.string().regex(/^TC-\d{2,4}$/),
  runner: z.enum(["api", "web", "mobile"]),
  spec: z.string().optional(),
  attempts: z.array(CaseAttemptSchema),
});

/** Parsed results file. */
export type CaseResultFile = z.infer<typeof CaseResultFileSchema>;
