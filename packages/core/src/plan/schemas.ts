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
  /** A manual test case imported for this run (REQ-CTX-08/AC2), by its `<system>:<id>`. */
  z.strictObject({
    kind: z.literal("imported"),
    id: z.string().regex(/^(xray|zephyr|testrail|file):[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  }),
  /** A screen, endpoint or transition end of the application map around the change (REQ-OBS-08). */
  z.strictObject({
    kind: z.literal("map"),
    id: z.string().regex(/^(page|api):\S.{0,300}$/),
  }),
  /** An observation of an exploratory session of this run (REQ-EXEC-15/AC4). */
  z.strictObject({
    kind: z.literal("observation"),
    session: z.string().regex(/^S\d{2,3}$/),
    id: z.string().regex(/^O\d{1,3}$/),
  }),
  /**
   * An item of an exploratory session a person accepted before planning (REQ-PLAN-11/AC4): an observation `O1`, a
   * finding `F1` or a not-done checklist item `C2`. It says what is worth testing, never what the result must be.
   */
  z.strictObject({
    kind: z.literal("explore"),
    session: z.string().regex(/^S\d{2,3}$/),
    item: z.string().regex(/^[OFC][1-9]\d{0,2}$/),
  }),
]);

/** A grounded source reference. */
export type SourceRef = z.infer<typeof SourceRefSchema>;

const Sources = z
  .array(SourceRefSchema)
  .min(
    1,
    'Every claim needs at least one source, e.g. {"kind":"ac","id":"AC1"} or {"kind":"quote","text":"<words of the ticket>"}; leave out a claim you cannot source',
  );

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

/** A locale name, e.g. `pl-PL` or `de` (REQ-EXEC-14). */
export const LocaleNameSchema = z.string().regex(/^[a-z]{2,3}(-[A-Z][A-Za-z]{1,3})?$/, "Locale like pl-PL");

/** Expected state of one UI element (REQ-EXEC-05, REQ-EXEC-40/AC2). */
const ElementStateSchema = z.strictObject({
  visible: z.boolean().optional(),
  enabled: z.boolean().optional(),
  checked: z.boolean().optional(),
  text: z.string().optional(),
  value: z.string().optional(),
  /** The element is inside the visible part of the page (after scrolling, REQ-EXEC-40/AC2). */
  in_viewport: z.boolean().optional(),
});

/**
 * An element selector of an expectation: `testid:`, `role:`, `label:`, `text:` or `css:`, optionally inside frames
 * (`frame:<selector> >> testid:pay`, REQ-EXEC-39/AC1); no dots, they separate the property in `verify()` fields.
 */
const ElementKeySchema = z.string().refine((key) => {
  const parts = key.split(" >> ");
  const last = parts.at(-1) ?? "";
  return (
    !key.includes(".") &&
    parts.length <= 8 &&
    /^(testid|role|label|text|css):.+$|^has-text:.+$|^nth:[1-9]\d{0,2}$/.test(last) &&
    parts
      .slice(0, -1)
      .every((p) =>
        /^(frame:(testid|title|id|css):.+|(testid|role|label|text|css|has-text):.+|nth:[1-9]\d{0,2})$/.test(
          p,
        ),
      )
  );
}, "Selector like testid:place-order, frame:title:Payment >> testid:pay or role:row >> has-text:Anna >> role:button:Delete (no dots)");

/** What a downloaded file must be (REQ-EXEC-38/AC2); every given part is checked by code. */
const DownloadExpectationSchema = z.strictObject({
  name: z.string().min(1).max(255).optional(),
  /** MIME type or file extension, e.g. `text/csv` or `csv`. */
  type: z.string().min(1).max(100).optional(),
  min_bytes: z.number().int().min(0).optional(),
  max_bytes: z.number().int().min(1).optional(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** Texts the content must contain (CSV, JSON, text, XLSX and PDF files). */
  texts: z.array(z.string().min(1)).max(50).optional(),
  /** How many files the step downloaded (REQ-EXEC-61/AC4); the other checks look at the last one. */
  count: z.number().int().min(1).max(100).optional(),
  /** Data rows of a CSV or the first XLSX sheet, header excluded. */
  rows: z.number().int().min(0).optional(),
  /** Values in a JSON file by path, as `fields` of a response. */
  fields: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Per-locale values of an expectation (REQ-EXEC-14/AC2): the same fields, texts and element states with the values
 * this locale shows (number, date and currency formats). Only keys of the base expectation can be overridden.
 */
const LocaleOverrideSchema = z.strictObject({
  fields: z.record(z.string(), z.unknown()).optional(),
  texts: z.array(z.string()).optional(),
  elements: z.record(z.string(), ElementStateSchema).optional(),
});

/**
 * Structured expectation of a step (REQ-PLAN-02/AC2). Generated tests read these through
 * `plan.expect(caseId, stepId)` (invariant 4); `description` is the human wording.
 */
export const ExpectationSchema = z
  .strictObject({
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
    elements: z.record(ElementKeySchema, ElementStateSchema).optional(),
    /** The browser dialog the step shows (REQ-EXEC-61/AC1): its type and message, as contained text. */
    dialog: z
      .strictObject({
        type: z.enum(["alert", "confirm", "prompt", "beforeunload"]).optional(),
        message: z.string().min(1).max(500).optional(),
      })
      .optional(),
    /** The file the step downloads (REQ-EXEC-38/AC2). */
    download: DownloadExpectationSchema.optional(),
    /**
     * The page's web app manifest, read by code (REQ-EXEC-65/AC3): its fields, the number of its icons, and whether a
     * service worker controls the page.
     */
    manifest: z
      .strictObject({
        name: z.string().min(1).max(200).optional(),
        short_name: z.string().min(1).max(100).optional(),
        start_url: z.string().min(1).max(500).optional(),
        display: z.enum(["fullscreen", "standalone", "minimal-ui", "browser"]).optional(),
        icons: z.number().int().min(0).max(100).optional(),
        controlled: z.boolean().optional(),
      })
      .optional(),
    /**
     * State the application exposes for tests (REQ-EXEC-56/AC2), read by the framework from the page's test hook
     * (`web.test_state`, default `window.__QA_STATE__`) by path: canvas charts, maps, editors.
     */
    state: z.record(z.string().regex(/^[A-Za-z0-9_$][\w$]*(\.[\w$]+|\[\d+\])*$/), z.unknown()).optional(),
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
    /**
     * The step's screenshot must match an approved baseline (REQ-EXEC-12/AC1): `name` identifies it, `threshold` is
     * the share of differing pixels that still passes, `mask` lists selectors of changing regions (dates, ads).
     */
    visual: z
      .strictObject({
        name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
        threshold: z.number().min(0).max(1).optional(),
        mask: z.array(z.string().min(1).max(200)).max(20).optional(),
        /** Compare only this element (a canvas, a chart) instead of the page (REQ-EXEC-56/AC2). */
        element: z.string().min(1).max(300).optional(),
      })
      .optional(),
    /** Values that differ per locale, by locale name (REQ-EXEC-14/AC2). */
    by_locale: z.record(LocaleNameSchema, LocaleOverrideSchema).optional(),
  })
  .superRefine((e, ctx) => {
    for (const [locale, o] of Object.entries(e.by_locale ?? {})) {
      for (const key of Object.keys(o.fields ?? {}))
        if (!(key in (e.fields ?? {})))
          ctx.addIssue({
            code: "custom",
            path: ["by_locale", locale, "fields", key],
            message: "Only planned fields can differ per locale",
          });
      if (o.texts && o.texts.length !== (e.texts ?? []).length)
        ctx.addIssue({
          code: "custom",
          path: ["by_locale", locale, "texts"],
          message: "Give one text per planned text",
        });
      for (const [selector, state] of Object.entries(o.elements ?? {}))
        for (const prop of Object.keys(state))
          if (!(prop in (e.elements?.[selector] ?? {})))
            ctx.addIssue({
              code: "custom",
              path: ["by_locale", locale, "elements", selector],
              message: "Only planned element states can differ per locale",
            });
    }
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
  /** Locales of the project this case also runs in (REQ-EXEC-14/AC1); expectations per locale in `by_locale`. */
  locales: z.array(LocaleNameSchema).optional(),
  /**
   * The browser of a web case (REQ-EXEC-61/AC2+AC3): the time it starts at (frozen until a step moves it), the
   * permissions it grants (everything else stays denied) and its location.
   */
  browser: z
    .strictObject({
      clock: z.iso.datetime({ offset: true }).optional(),
      /**
       * Lets the application register service workers (REQ-EXEC-65/AC1); only in a browser where QAJitsu still checks
       * every request of the worker against the allowlist (Chromium), otherwise the case is BLOCKED.
       */
      service_workers: z.boolean().optional(),
      permissions: z
        .array(
          z.enum([
            "geolocation",
            "notifications",
            "clipboard-read",
            "clipboard-write",
            "camera",
            "microphone",
          ]),
        )
        .max(6)
        .optional(),
      geolocation: z
        .strictObject({
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180),
          accuracy: z.number().min(0).max(100_000).optional(),
        })
        .optional(),
    })
    .optional(),
  /**
   * Files the case uploads, by key (REQ-EXEC-38/AC1): a file of the project's `.qa/fixtures/`, or one generated by code
   * with a name, a type and a size. A spec names the key; it never passes a path or bytes.
   */
  files: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/),
      z.union([
        z.strictObject({
          fixture: z
            .string()
            .regex(/^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9_./-]{1,200}$/, "A path inside .qa/fixtures/"),
        }),
        z.strictObject({
          name: z.string().regex(/^[A-Za-z0-9_.() -]{1,100}$/),
          type: z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/),
          bytes: z.number().int().min(0).max(50_000_000),
        }),
      ]),
    )
    .optional(),
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
          /**
           * How the step answers browser dialogs (REQ-EXEC-61/AC1): accept, dismiss, or accept a prompt with a text.
           * Without it a dialog is dismissed and recorded.
           */
          dialog: z
            .strictObject({ action: z.enum(["accept", "dismiss"]), text: z.string().max(500).optional() })
            .optional(),
          /** Most scrolls of `ui.scrollUntil` in this step (REQ-EXEC-40/AC2); 20 when not given. */
          scroll_limit: z.number().int().min(1).max(200).optional(),
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
            e.elements !== undefined ||
            e.download !== undefined ||
            e.state !== undefined
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
/** Test depth (REQ-PLAN-08): smoke keeps high-risk cases, standard high and medium, full every case. */
export const DepthSchema = z.enum(["smoke", "standard", "full"]);

/** Test depth. */
export type Depth = z.infer<typeof DepthSchema>;

/** One planned case and why it is in or out at the chosen depth (REQ-PLAN-08/AC1). */
export const SelectionSchema = z.strictObject({
  case: z.string(),
  title: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  included: z.boolean(),
  reason: z.string(),
});

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
    /** Test depth the cases were selected for (REQ-PLAN-08/AC1); absent means every case (full). */
    depth: DepthSchema.optional(),
    /** Why each planned case is in or out at that depth (REQ-PLAN-08/AC1), recorded by code. */
    selection: z.array(SelectionSchema).default([]),
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
  depth: DepthSchema.optional(),
  selection: z.array(SelectionSchema).default([]),
});

/** Plan content produced by the planner. */
export type PlanDraft = z.infer<typeof PlanDraftSchema>;
