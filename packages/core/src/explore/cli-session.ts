import { z } from "zod";
import { ActionIdSchema, ObservationSchema } from "./session.js";

/** One command-line action the trusted parent performed for the explorer (REQ-EXEC-24/AC3). */
export const CliActionSchema = z.strictObject({
  id: ActionIdSchema,
  /**
   * `run` (wait for the end), `start` (in the background), `send` (a line to a background command), `signal`,
   * `wait`, `read` (a file of the sandbox), `list` (a folder of the sandbox) or `leftovers`.
   */
  action: z.enum(["run", "start", "send", "signal", "wait", "read", "list", "leftovers"]),
  /** Arguments after the tool's own command, masked. */
  args: z.array(z.string().max(1000)).max(100).default([]),
  /** Background command the action refers to, e.g. `B1`. */
  background: z
    .string()
    .regex(/^B\d{1,3}$/)
    .optional(),
  /** Lines given on standard input (masked), or the signal sent. */
  input: z.array(z.string().max(1000)).max(50).optional(),
  signal: z.enum(["SIGINT", "SIGTERM"]).optional(),
  /** Path inside the sandbox for `read` and `list`. */
  path: z.string().max(1000).optional(),
  ok: z.boolean(),
  /** Exit code of a finished command; absent while it still runs or when a signal ended it. */
  exitCode: z.number().int().optional(),
  /** Signal that ended the command, if any. */
  endedBy: z.string().max(20).optional(),
  /** The command was stopped by the per-command timeout. */
  timedOut: z.boolean().default(false),
  /** Still running after the action (background commands). */
  running: z.boolean().default(false),
  durationMs: z.number().int().nonnegative(),
  error: z.string().max(1000).optional(),
  /** Output of the action (stdout and stderr, masked), a path in the session's evidence manifest. */
  output: z.string().optional(),
  /** Files of the sandbox the action added, changed or removed, relative to the sandbox. */
  changed: z.array(z.string().max(500)).max(200).default([]),
  at: z.string(),
});

/** What a session left running or behind, found by code (REQ-EXEC-24/AC3+AC5). */
export const CliLeftoversSchema = z.strictObject({
  processes: z.array(z.string().max(500)).max(200),
  containers: z.array(z.string().max(500)).max(200),
});

/** `explore/<session>/session.json` of a command-line session (REQ-EXEC-24). */
export const CliExploreSessionSchema = z.strictObject({
  schema: z.literal(1),
  kind: z.literal("cli"),
  id: z.string().regex(/^S\d{2,3}$/),
  ticket: z.string(),
  run: z.string(),
  goal: z.string().min(1).max(1000),
  /** Name of the tool in `explore.cli` and the command it runs (masked). */
  tool: z.strictObject({ name: z.string(), command: z.array(z.string()) }),
  model: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  endReason: z.enum(["finished", "time-box", "step-budget", "error"]),
  error: z.string().max(2000).optional(),
  budget: z.strictObject({ minutes: z.number().positive(), steps: z.number().int().positive() }),
  summary: z.string().max(4000).default(""),
  actions: z.array(CliActionSchema),
  observations: z.array(ObservationSchema),
  /** Left running when the agent finished, before the teardown. */
  leftovers: CliLeftoversSchema,
  /** Stopped or removed by the teardown and the clean-up of the session. */
  cleaned: CliLeftoversSchema,
  /** Network requests the proxy refused (host:port), the tool's attempts outside its allowlist. */
  refusedHosts: z.array(z.string().max(300)).max(200).default([]),
});

/** A recorded command-line action. */
export type CliAction = z.infer<typeof CliActionSchema>;
/** What a command-line session left behind. */
export type CliLeftovers = z.infer<typeof CliLeftoversSchema>;
/** A whole command-line exploratory session. */
export type CliExploreSession = z.infer<typeof CliExploreSessionSchema>;
