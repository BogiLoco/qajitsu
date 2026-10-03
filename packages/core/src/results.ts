import { z } from "zod";

/** One assertion recorded by `verify()` (REQ-EXEC-02/AC2). */
export const AssertionRecordSchema = z.strictObject({
  stepId: z.string(),
  field: z.string(),
  expected: z.unknown(),
  actual: z.unknown(),
  pass: z.boolean(),
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
