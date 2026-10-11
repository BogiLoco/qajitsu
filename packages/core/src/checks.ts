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

/** Suggested causes of a FAILED case (REQ-VER-12/AC1). A hint is never a status. */
export const TRIAGE_CATEGORIES = ["product-bug", "test-bug", "environment", "data"] as const;

/** Evidence a hint cites: a step, an assertion (`S1.status`), an evidence file or a log file of the run. */
export const TriageCiteSchema = z.strictObject({
  kind: z.enum(["step", "assertion", "evidence", "log"]),
  ref: z.string().min(1).max(300),
});

/** One hint for one FAILED case, with the citations code verified. */
export const TriageHintSchema = z.strictObject({
  caseId: z.string(),
  category: z.enum(TRIAGE_CATEGORIES),
  justification: z.string().min(1).max(600),
  cites: z.array(TriageCiteSchema).min(1),
});

/** A triage hint. */
export type TriageHint = z.infer<typeof TriageHintSchema>;

/**
 * `checks/triage.json`: hints for FAILED cases (REQ-VER-12). Written by the orchestrator from the validated model
 * answer after code dropped hints without real evidence; never read by status computation.
 */
export const TriageRecordSchema = z.discriminatedUnion("status", [
  z.strictObject({
    schema: z.literal(1),
    status: z.literal("done"),
    model: z.string(),
    hints: z.array(TriageHintSchema),
    /** Case ids whose hint was dropped because it cited nothing that exists (REQ-VER-12/AC2). */
    dropped: z.array(z.string()).default([]),
  }),
  z.strictObject({ schema: z.literal(1), status: z.literal("failed"), error: z.string() }),
]);

/** Parsed `checks/triage.json`. */
export type TriageRecord = z.infer<typeof TriageRecordSchema>;

/**
 * Why a case could not be judged (REQ-VER-13/AC1): the generated test, the plan, the environment, the tooling (device,
 * browser, Appium) or the configuration.
 */
export const BLOCKED_CATEGORIES = ["spec", "plan", "environment", "tooling", "configuration"] as const;

/** What a BLOCKED hint cites: a step, an evidence or log file, a line of the spec (`12`) or the attempt's `error`. */
export const BlockedCiteSchema = z.strictObject({
  kind: z.enum(["step", "evidence", "log", "spec", "error"]),
  ref: z.string().min(1).max(300),
});

/** One hint for one BLOCKED case: the likely cause and what to do next, with citations code verified. */
export const BlockedHintSchema = z.strictObject({
  caseId: z.string(),
  category: z.enum(BLOCKED_CATEGORIES),
  justification: z.string().min(1).max(600),
  next: z.string().min(1).max(300),
  cites: z.array(BlockedCiteSchema).min(1),
});

/** A hint for a BLOCKED case. */
export type BlockedHint = z.infer<typeof BlockedHintSchema>;

/**
 * `checks/blocked.json`: hints for BLOCKED cases (REQ-VER-13). Written by the orchestrator after code dropped hints
 * without real citations; never read by status computation (invariant 1).
 */
export const BlockedRecordSchema = z.discriminatedUnion("status", [
  z.strictObject({
    schema: z.literal(1),
    status: z.literal("done"),
    model: z.string(),
    hints: z.array(BlockedHintSchema),
    dropped: z.array(z.string()).default([]),
  }),
  z.strictObject({ schema: z.literal(1), status: z.literal("failed"), error: z.string() }),
]);

/** Parsed `checks/blocked.json`. */
export type BlockedRecord = z.infer<typeof BlockedRecordSchema>;
