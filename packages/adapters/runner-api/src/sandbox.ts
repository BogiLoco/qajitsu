import { pausedStep, startDeadline } from "./deadline.js";
import type { AttemptExecutor as CoreAttemptExecutor } from "@qajitsu/core";
import { fork } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCaseRuntime,
  createMasker,
  type ApiTransport,
  type AttemptRecord,
  type CaseRuntime,
  type EvidenceItem,
  type UiDriver,
} from "@qajitsu/steps";
import { z } from "zod";
import type { AttemptInput } from "./attempt.js";
import { createPlaywrightTransport } from "./transport.js";

/** Executes one attempt; the sandbox in production, in-process in unit tests. */
/** The runner seam from `@qajitsu/core` (ADR-0005). */
export type AttemptExecutor = CoreAttemptExecutor;

/**
 * Node flags of the sandbox: permission model with read access to the given folders only, no writes,
 * no network, no child processes or workers; TypeScript type stripping for `.ts` specs.
 *
 * @param readable - Folders the child may read.
 */
export function sandboxFlags(readable: readonly string[]): string[] {
  const flags = process.allowedNodeEnvironmentFlags;
  const permission = flags.has("--permission") ? "--permission" : "--experimental-permission";
  const strip = (process.features as { typescript?: unknown }).typescript
    ? []
    : ["--experimental-strip-types"];
  return [
    permission,
    ...readable.map((r) => `--allow-fs-read=${r}`),
    ...strip,
    "--disable-warning=ExperimentalWarning",
  ];
}

const Options = z.strictObject({
  headers: z.record(z.string(), z.string()).optional(),
  query: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

const Selector = z.string().max(300);
const UiOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("goto"), path: z.string().max(4096) }),
  z.strictObject({ op: z.enum(["click", "check", "uncheck"]), selector: Selector }),
  z.strictObject({
    op: z.enum(["fill", "select", "press"]),
    selector: Selector,
    value: z.string().max(10_000),
  }),
  z.strictObject({ op: z.literal("waitFor"), selector: Selector, state: z.enum(["visible", "hidden"]) }),
  z.strictObject({ op: z.literal("back") }),
  z.strictObject({ op: z.literal("as"), alias: z.string().max(200) }),
]);

/** A browser for one attempt, created by the web runner (ADR-0004). */
export interface BrowserSession {
  /** Starts the browser on first use. */
  readonly driver: () => Promise<UiDriver>;
  /** Closes the browser and returns case evidence: video, trace, HAR, console log (REQ-EVD-02). */
  readonly close: (failed: boolean) => Promise<EvidenceItem[]>;
}

/** Creates the browser session of an attempt; absent for API-only runs. */
export type BrowserFactory = (input: AttemptInput) => BrowserSession;

/** Operations a child may ask for; anything else ends the attempt as an error. */
const OpSchema = z.discriminatedUnion("op", [
  z.strictObject({
    type: z.literal("op"),
    id: z.number().int(),
    op: z.literal("beginStep"),
    stepId: z.string(),
  }),
  z.strictObject({
    type: z.literal("op"),
    id: z.number().int(),
    op: z.literal("endStep"),
    stepId: z.string(),
    error: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("op"),
    id: z.number().int(),
    op: z.literal("verify"),
    stepId: z.string(),
    field: z.string(),
  }),
  z.strictObject({
    type: z.literal("op"),
    id: z.number().int(),
    op: z.literal("ui"),
    operation: UiOperationSchema,
  }),
  z.strictObject({
    type: z.literal("op"),
    id: z.number().int(),
    op: z.literal("inboxAddress"),
    kind: z.enum(["email", "url"]),
  }),
  z.strictObject({
    type: z.literal("op"),
    id: z.number().int(),
    op: z.literal("inboxWait"),
    stepId: z.string().max(10),
  }),
  z.strictObject({
    type: z.literal("op"),
    id: z.number().int(),
    op: z.literal("call"),
    alias: z.string().optional(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().max(4096),
    body: z.unknown().optional(),
    options: Options,
  }),
]);
const DoneSchema = z.strictObject({ type: z.literal("done"), error: z.string().max(10_000).optional() });

/** Expectations of one case, keyed `<case>.<step>.<field>`, for `plan.expect` in the child. */
const expectationsOf = (input: AttemptInput): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  const c = input.plan.cases.find((x) => x.id === input.caseId);
  for (const s of c?.steps ?? []) {
    const p = `${input.caseId}.${s.id}`;
    out[`${p}.description`] = s.expect.description;
    if (s.expect.status !== undefined) out[`${p}.status`] = s.expect.status;
    for (const [k, v] of Object.entries(s.expect.fields ?? {})) out[`${p}.fields.${k}`] = v;
    (s.expect.texts ?? []).forEach((t, i) => (out[`${p}.texts.${String(i)}`] = t));
    for (const [selector, state] of Object.entries(s.expect.elements ?? {})) {
      for (const [prop, value] of Object.entries(state)) out[`${p}.elements.${selector}.${prop}`] = value;
    }
  }
  return out;
};

const both = (paths: readonly string[]): string[] => [
  ...new Set(
    paths.flatMap((p) => {
      try {
        return [p, realpathSync(p)];
      } catch {
        return [p];
      }
    }),
  ),
];

/**
 * Creates the sandboxed executor (REQ-EXEC-04, invariants 1, 2, 4, 8, 10). The spec runs in a child
 * process that can only read its own folder; every HTTP call, step and assertion is performed and
 * recorded here, in the parent, from the parent's own responses and the approved plan.
 *
 * @param options - Built `child.js`, an HTTP transport (default: Playwright per attempt) and the clock.
 */
export function createSandboxExecutor(
  options: {
    readonly childScript?: string;
    readonly transport?: ApiTransport;
    readonly now?: () => number;
    /** Browser per attempt for web and mixed cases (REQ-EXEC-05, REQ-EXEC-07). */
    readonly browser?: BrowserFactory;
  } = {},
): AttemptExecutor {
  const childScript = options.childScript ?? fileURLToPath(new URL("./child.js", import.meta.url));
  const now = options.now ?? Date.now;
  return async (input) => {
    let dispose: (() => Promise<void>) | undefined;
    let transport = options.transport;
    if (!transport) {
      const pw = await createPlaywrightTransport({ timeoutMs: input.timeoutMs });
      transport = pw.transport;
      dispose = pw.dispose;
    }
    const session = options.browser?.(input);
    const runtime: CaseRuntime = createCaseRuntime({
      plan: input.plan,
      ...(input.visual ? { visual: input.visual } : {}),
      ...(input.locale ? { locale: input.locale.name } : {}),
      ...(input.messages ? { messages: input.messages } : {}),
      ...(input.manual ? { manual: input.manual } : {}),
      caseId: input.caseId,
      attempt: input.attempt,
      baseUrl: input.baseUrl,
      transport,
      masker: createMasker({ secrets: input.secrets }),
      allowedOrigins: input.allowedOrigins,
      accounts: input.accounts,
      now,
      ...(session ? { ui: session.driver } : {}),
      ...(input.progress
        ? {
            onScreenshot: (stepId: string, png: Uint8Array) => {
              input.progress?.screenshot(stepId, png);
            },
          }
        : {}),
    });
    let specFile = input.specFile;
    try {
      specFile = realpathSync(input.specFile);
    } catch {
      // A missing spec errors inside the child and becomes an error attempt.
    }
    try {
      return await new Promise<AttemptRecord>((resolve) => {
        const child = fork(childScript, [], {
          execArgv: sandboxFlags(
            both([
              dirname(specFile),
              dirname(input.specFile),
              dirname(childScript),
              dirname(dirname(childScript)),
            ]),
          ),
          env: { PATH: process.env["PATH"] ?? "" },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          serialization: "advanced",
        });
        let stderr = "";
        child.stderr?.on("data", (d: Buffer) => {
          stderr = (stderr + d.toString()).slice(-2000);
        });
        let settled = false;
        let fatal: string | undefined;
        const done = (error?: string): void => {
          if (settled) return;
          settled = true;
          deadline.clear();
          child.kill("SIGKILL");
          void runtime.finish(fatal ?? error).then(async (record) => {
            const media = session ? await session.close(record.outcome !== "passed").catch(() => []) : [];
            resolve({ ...record, evidence: [...record.evidence, ...media] });
          });
        };
        const deadline = startDeadline(input.timeoutMs, () => {
          done(`case timed out after ${String(input.timeoutMs)} ms`);
        });
        // Operations are processed strictly in order, one at a time.
        let queue: Promise<void> = Promise.resolve();
        child.on("message", (raw: unknown) => {
          queue = queue.then(async () => {
            if (settled) return;
            const finished = DoneSchema.safeParse(raw);
            if (finished.success) {
              done(finished.data.error);
              return;
            }
            const parsed = OpSchema.safeParse(raw);
            if (!parsed.success) {
              fatal = "sandbox sent an invalid message; the attempt is void";
              done();
              return;
            }
            const op = parsed.data;
            try {
              let value: unknown;
              if (op.op === "beginStep") {
                // REQ-EXEC-16/AC3: a person watching decides when the step runs; the time limit stands still.
                if (input.pause) {
                  deadline.pause();
                  const answer = await input.pause(pausedStep(input.plan, input.caseId, op.stepId));
                  deadline.resume();
                  if (answer === "stop") throw new Error(`stopped by the tester before ${op.stepId}`);
                }
                runtime.beginStep(op.stepId);
                input.progress?.step(op.stepId);
              } else if (op.op === "endStep") await runtime.endStep(op.stepId, op.error);
              else if (op.op === "verify") await runtime.verify(op.stepId, op.field);
              else if (op.op === "ui") await runtime.uiOp(op.operation);
              else if (op.op === "inboxAddress") value = await runtime.inboxAddress(op.kind);
              else if (op.op === "inboxWait") value = (await runtime.inboxWait(op.stepId)) ?? null;
              else {
                const r = await runtime.call(op.alias, op.method, op.path, op.body, {
                  ...(op.options.headers ? { headers: op.options.headers } : {}),
                  ...(op.options.query ? { query: op.options.query } : {}),
                });
                value = { status: r.status, headers: r.headers, text: r.text };
              }
              child.send({ type: "reply", id: op.id, ok: true, value });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              // A refused operation is a broken spec: the attempt errors even if the spec catches it.
              fatal ??= message;
              child.send({ type: "reply", id: op.id, ok: false, error: message });
            }
          });
        });
        child.on("exit", (code) => {
          void queue.then(() => {
            done(
              `sandbox exited with code ${String(code)}: ${stderr.trim().split("\n").slice(-3).join(" ")}`,
            );
          });
        });
        child.send({ type: "start", specFile, caseId: input.caseId, expectations: expectationsOf(input) });
      });
    } finally {
      await dispose?.();
    }
  };
}
