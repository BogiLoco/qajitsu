import { z } from "zod";

/** Action ids of a session: `A01`, `A02`, ... */
export const ActionIdSchema = z.string().regex(/^A\d{2,3}$/);

/** One browser action the trusted parent performed for the explorer, with what it recorded (REQ-EXEC-15/AC2). */
export const ExploreActionSchema = z.strictObject({
  id: ActionIdSchema,
  /** `goto`, `click`, `fill`, `select`, `press`, `back` or `login_as`. */
  action: z.enum(["goto", "click", "fill", "select", "press", "back", "login_as"]),
  /** Selector, path or alias the action used; never a secret (fill values are masked). */
  target: z.string().max(400),
  value: z.string().max(400).optional(),
  ok: z.boolean(),
  error: z.string().max(1000).optional(),
  /** Page after the action. */
  url: z.string().max(2000),
  /** Screenshot after the action, a path in the session's evidence manifest. */
  screenshot: z.string().optional(),
  at: z.string(),
});

/** One thing the explorer noticed, for a person to assess (REQ-EXEC-15/AC3). Never a status. */
export const ObservationSchema = z.strictObject({
  id: z.string().regex(/^O\d{1,3}$/),
  title: z.string().min(3).max(200),
  kind: z.enum(["possible-bug", "ux", "question", "risk"]),
  severity: z.enum(["low", "medium", "high"]),
  description: z.string().min(1).max(4000),
  /** Steps to reproduce: actions of this session, in order. */
  steps: z.array(ActionIdSchema).min(1).max(40),
  expected: z.string().max(1000).default(""),
  actual: z.string().max(1000).default(""),
});

/**
 * One item of a session's goal checklist (REQ-EXEC-25): from the person (`--check`) or written by the explorer from
 * the goal; done with the actions that did it, or not done with the reason. Never a status.
 */
export const ChecklistItemSchema = z.strictObject({
  item: z.string().min(1).max(300),
  source: z.enum(["person", "explorer"]),
  actions: z.array(ActionIdSchema).max(40),
  notDone: z.string().max(1000).optional(),
  /** What code changed in the explorer's claim and why (REQ-EXEC-25/AC10); absent when it stood as given. */
  corrected: z.string().max(500).optional(),
});

/** One thing the explorer reports having seen, with the actions that show it (REQ-EXEC-25/AC2). */
export const FindingSchema = z.strictObject({
  text: z.string().min(1).max(600),
  actions: z.array(ActionIdSchema).min(1).max(40),
});

/** `explore/<session>/session.json`: what an exploratory session did and noticed (REQ-EXEC-15). */
export const ExploreSessionSchema = z.strictObject({
  schema: z.literal(1),
  id: z.string().regex(/^S\d{2,3}$/),
  ticket: z.string(),
  run: z.string(),
  goal: z.string().min(1).max(1000),
  environment: z.strictObject({ name: z.string(), baseUrl: z.string() }),
  model: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  /** Why the session stopped; the time box and the step budget are enforced by code (REQ-EXEC-15/AC5). */
  endReason: z.enum(["finished", "time-box", "step-budget", "error"]),
  error: z.string().max(2000).optional(),
  budget: z.strictObject({ minutes: z.number().positive(), steps: z.number().int().positive() }),
  /** The explorer's comment, checked against the actions; the checklist and findings carry the claims. */
  summary: z.string().max(4000).default(""),
  checklist: z.array(ChecklistItemSchema).max(30).default([]),
  findings: z.array(FindingSchema).max(30).default([]),
  actions: z.array(ExploreActionSchema),
  observations: z.array(ObservationSchema),
  /** Session-wide recordings in the evidence manifest: video, trace, network, console. */
  recordings: z.array(z.string()),
});

/** A recorded browser action. */
export type ExploreAction = z.infer<typeof ExploreActionSchema>;
/** An observation of an exploratory session. */
export type Observation = z.infer<typeof ObservationSchema>;
/** An item of a session's goal checklist. */
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;
/** A finding of an explorer, citing actions. */
export type Finding = z.infer<typeof FindingSchema>;
/** A whole exploratory session. */
export type ExploreSession = z.infer<typeof ExploreSessionSchema>;
