import { z } from "zod";

/**
 * Where a claim or test case comes from (REQ-PLAN-03/AC1, REQ-PLAN-01/AC2): an acceptance criterion id
 * (`AC1` = first criterion of the ticket snapshot), a verbatim quote from the ticket or the project's documentation, a file and line
 * range from the diff, or a review comment by index.
 */
export const SourceRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ac"), id: z.string().regex(/^AC[1-9]\d*$/) }),
  z.strictObject({ kind: z.literal("quote"), text: z.string().min(3) }),
  z.strictObject({
    kind: z.literal("diff"),
    repo: z.string().min(1),
    file: z.string().min(1),
    /** New-side line range `10` or `10-20`; omitted means the whole file change. */
    lines: z
      .string()
      .regex(/^\d+(?:-\d+)?$/)
      .optional(),
  }),
  z.strictObject({
    kind: z.literal("comment"),
    repo: z.string().min(1),
    index: z.number().int().nonnegative(),
  }),
  /**
   * A verbatim quote from a chunk of the project's knowledge base (REQ-KNOW-06/AC2+AC3). `path`, `section`,
   * `modified` and `outdated` are filled by code from the stored chunk, never trusted from the model.
   */
  z.strictObject({
    kind: z.literal("doc"),
    chunk: z.string().regex(/^[0-9a-f]{16}-\d+$/),
    quote: z.string().min(12),
    path: z.string().optional(),
    section: z.string().optional(),
    modified: z.string().optional(),
    outdated: z.boolean().optional(),
  }),
  /** An observation of an exploratory session of this run (REQ-EXEC-15/AC4). */
  z.strictObject({
    kind: z.literal("observation"),
    session: z.string().regex(/^S\d{2,3}$/),
    id: z.string().regex(/^O\d{1,3}$/),
  }),
]);

/** A grounded source reference. */
export type SourceRef = z.infer<typeof SourceRefSchema>;

const Sources = z.array(SourceRefSchema).min(1, "Every claim needs at least one source");

const QuestionSchema = z.strictObject({
  id: z.string().regex(/^Q[1-9]\d*$/),
  question: z.string().min(5),
  why: z.string().optional(),
});

/** Output of the analyst agent, stored as `analysis.json` (REQ-PLAN-01). */
export const AnalysisSchema = z
  .strictObject({
    summary: z.string().min(1),
    change_type: z.array(z.enum(["api", "web", "mobile"])).min(1),
    endpoints: z
      .array(z.strictObject({ method: z.string().optional(), path: z.string().min(1), source: Sources }))
      .default([]),
    screens: z.array(z.strictObject({ name: z.string().min(1), source: Sources })).default([]),
    risks: z.array(z.strictObject({ description: z.string().min(1), source: Sources })).default([]),
    confidence: z.enum(["high", "medium", "low"]),
    open_questions: z.array(QuestionSchema).default([]),
  })
  .refine((a) => a.confidence !== "low" || a.open_questions.length > 0, {
    message: "Low confidence requires open questions instead of guesses (REQ-PLAN-01/AC3)",
    path: ["open_questions"],
  });

/** Parsed analysis. */
export type Analysis = z.infer<typeof AnalysisSchema>;

/**
 * Structured expectation of a step (REQ-PLAN-02/AC2). Generated tests read these through
 * `plan.expect(caseId, stepId)` (invariant 4); `description` is the human wording.
 */
export const ExpectationSchema = z.strictObject({
  description: z.string().min(1),
  status: z.number().int().min(100).max(599).optional(),
  /** JSON paths in a response body with their expected values, e.g. `{"total": 10.05}`. */
  fields: z.record(z.string(), z.unknown()).optional(),
  /** Texts that must be visible (web/mobile). */
  texts: z.array(z.string()).optional(),
  /**
   * Expected state of UI elements by selector (`testid:place-order`, `role:button:Pay`, `label:Email`,
   * `text:Total`), e.g. `{ "testid:place-order": { "enabled": true } }` (REQ-EXEC-05).
   */
  elements: z
    .record(
      z.string().regex(/^(testid|role|label|text|css):[^.]+$/, "Selector like testid:place-order (no dots)"),
      z.strictObject({
        visible: z.boolean().optional(),
        enabled: z.boolean().optional(),
        checked: z.boolean().optional(),
        text: z.string().optional(),
        value: z.string().optional(),
      }),
    )
    .optional(),
  /**
   * A message the step must receive in the case's inbox (REQ-ENV-08/AC2): an e-mail, an SMS forwarded to a webhook,
   * or an outgoing webhook. Every given part must be contained (case-insensitive); none arriving in time fails.
   */
  message: z
    .strictObject({
      to: z.string().min(1).max(200).optional(),
      subject: z.string().min(1).max(300).optional(),
      body: z.string().min(1).max(500).optional(),
      within_s: z.number().int().min(1).max(3600).optional(),
    })
    .optional(),
});

/** Structured expectation. */
export type Expectation = z.infer<typeof ExpectationSchema>;

/** One test case of the plan (REQ-PLAN-02/AC1). */
export const TestCaseSchema = z.strictObject({
  id: z.string().regex(/^TC-\d{2,4}$/, "Case ids look like TC-01"),
  title: z.string().min(3),
  type: z.enum(["api", "web", "mobile"]),
  priority: z.enum(["high", "medium", "low"]),
  /**
   * The case reproduces the reported bug: it must fail on the version before the fix and pass with it
   * (`qj run --fix-check`, REQ-VER-11).
   */
  reproduces: z.boolean().default(false),
  source: Sources,
  preconditions: z.array(z.string()).default([]),
  /** Test data by alias only, e.g. `{ user: "user:standard" }`; never secret values (invariant 8). */
  data: z
    .record(z.string(), z.string().regex(/^[a-z][a-z0-9_-]*:[a-z0-9_.-]+$/, "Use aliases like user:standard"))
    .default({}),
  steps: z
    .array(
      z
        .strictObject({
          id: z.string().regex(/^S\d{1,3}$/),
          action: z.string().min(1),
          expect: ExpectationSchema,
          /**
           * A step a person performs (REQ-EXEC-11): an SMS or 2FA code, a physical device, a printout. The run pauses
           * and asks a tester for the outcome; its expectation is a description only.
           */
          manual: z.boolean().optional(),
          /** What the tester does and checks; required for a manual step. */
          instructions: z.string().min(3).max(1000).optional(),
        })
        .superRefine((step, ctx) => {
          if (step.manual !== true) return;
          if (step.instructions === undefined)
            ctx.addIssue({
              code: "custom",
              path: ["instructions"],
              message: "A manual step needs instructions",
            });
          const e = step.expect;
          if (
            e.status !== undefined ||
            e.fields !== undefined ||
            e.texts !== undefined ||
            e.elements !== undefined
          )
            ctx.addIssue({
              code: "custom",
              path: ["expect"],
              message: "A manual step is checked by a person: its expectation is a description only",
            });
        }),
    )
    .min(1),
  evidence: z.array(z.enum(["request", "response", "screenshot", "video", "trace", "log", "har"])).min(1),
});

/** One test case. */
export type TestCase = z.infer<typeof TestCaseSchema>;

/** An existing test of the tests repository that already covers part of the ticket (REQ-CTX-06/AC2). */
const ExistingCoverageSchema = z.strictObject({
  repo: z.string().min(1),
  file: z.string().min(1),
  /** Title of the test exactly as in the file. */
  title: z.string().min(1),
  /** What it covers: criteria (`AC2`) or a short description. */
  covers: z.array(z.string().min(1)).min(1),
});

/** A test plan version, `plan/plan.vN.yaml` (REQ-PLAN-02). */
export const PlanSchema = z
  .strictObject({
    schema: z.literal(1),
    ticket: z.string(),
    version: z.number().int().positive(),
    summary: z.string().default(""),
    cases: z.array(TestCaseSchema).min(1),
    open_questions: z.array(QuestionSchema).default([]),
    out_of_scope: z.array(z.string()).default([]),
    existing_coverage: z.array(ExistingCoverageSchema).default([]),
  })
  .superRefine((plan, ctx) => {
    const seen = new Set<string>();
    plan.cases.forEach((c, i) => {
      if (seen.has(c.id))
        ctx.addIssue({ code: "custom", path: ["cases", i, "id"], message: `Duplicate case id ${c.id}` });
      seen.add(c.id);
      const steps = new Set<string>();
      c.steps.forEach((s, j) => {
        if (steps.has(s.id)) {
          ctx.addIssue({
            code: "custom",
            path: ["cases", i, "steps", j, "id"],
            message: `Duplicate step id ${s.id}`,
          });
        }
        steps.add(s.id);
      });
    });
  });

/** Parsed plan. */
export type Plan = z.infer<typeof PlanSchema>;

/** Plan content as the planner writes it; `schema`, `ticket` and `version` are set by code. */
export const PlanDraftSchema = z.strictObject({
  summary: z.string().default(""),
  cases: z.array(TestCaseSchema).min(1),
  open_questions: z.array(QuestionSchema).default([]),
  out_of_scope: z.array(z.string()).default([]),
  existing_coverage: z.array(ExistingCoverageSchema).default([]),
});

/** Plan content produced by the planner. */
export type PlanDraft = z.infer<typeof PlanDraftSchema>;
