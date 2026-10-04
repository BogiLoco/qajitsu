import { z } from "zod";

/**
 * `checks/audit.json`: what the independent auditor found (REQ-VER-06). Written by the orchestrator,
 * never by an agent tool (the guard protects `checks/`). Findings can only downgrade PASSED.
 */
export const AuditRecordSchema = z.discriminatedUnion("status", [
  z.strictObject({
    schema: z.literal(1),
    status: z.literal("done"),
    mode: z.enum(["optional", "required"]),
    model: z.string(),
    sameModelAsAuthor: z.boolean(),
    findings: z.array(z.strictObject({ caseId: z.string(), weak: z.boolean(), reason: z.string() })),
  }),
  z.strictObject({
    schema: z.literal(1),
    status: z.literal("failed"),
    mode: z.enum(["optional", "required"]),
    error: z.string(),
  }),
]);

/** Parsed `checks/audit.json`. */
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

/**
 * `checks/canary.json`: one step run with an inverted expectation (REQ-VER-09). `caught` is true when
 * the runner reported the inverted assertion as failed, which is what a working test must do.
 */
export const CanaryRecordSchema = z.strictObject({
  schema: z.literal(1),
  /** `ran`: the canary executed; `skipped`: no PASSED case with an expectation; `error`: it could not run (counts as not caught). */
  status: z.enum(["ran", "skipped", "error"]).default("ran"),
  caseId: z.string(),
  stepId: z.string(),
  field: z.string(),
  caught: z.boolean(),
  detail: z.string(),
});

/** Parsed `checks/canary.json`. */
export type CanaryRecord = z.infer<typeof CanaryRecordSchema>;
