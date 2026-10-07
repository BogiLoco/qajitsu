import { pathToFileURL } from "node:url";
import type { AttemptRequest } from "@qajitsu/core";
import { pausedStep, startDeadline, type Deadline } from "./deadline.js";
import type { BrowserFactory } from "./sandbox.js";
import {
  createCaseRuntime,
  createMasker,
  type ApiTransport,
  type AttemptRecord,
  type CaseContext,
} from "@qajitsu/steps";

/** Everything one attempt needs; sent to the sandboxed child over IPC. Never contains raw config secrets. */
/** One attempt of one case; the core `AttemptRequest` (ADR-0005). */
export type AttemptInput = AttemptRequest;

/** Shape a spec module must export. */
interface SpecModule {
  readonly caseId?: unknown;
  readonly run?: unknown;
}

const withTimeout = async <T>(run: (deadline: Deadline) => Promise<T>, ms: number): Promise<T> => {
  let deadline: Deadline | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      deadline = startDeadline(ms, () => {
        reject(new Error(`case timed out after ${String(ms)} ms`));
      });
      run(deadline).then(resolve, reject);
    });
  } finally {
    deadline?.clear();
  }
};

/**
 * Runs one attempt of one spec: imports it, checks it belongs to the case, runs `run(context)` and
 * returns what was recorded. Used inside the sandboxed child process and by in-process tests.
 *
 * @param input - Attempt settings.
 * @param transport - HTTP transport (Playwright in production).
 * @param now - Clock in milliseconds.
 * @param browser - Browser factory for web and mixed cases.
 */
export async function executeAttempt(
  input: AttemptInput,
  transport: ApiTransport,
  now: () => number = Date.now,
  browser?: BrowserFactory,
): Promise<AttemptRecord> {
  const session = browser?.(input);
  const masker = createMasker({ secrets: input.secrets });
  const runtime = createCaseRuntime({
    plan: input.plan,
    ...(input.visual ? { visual: input.visual } : {}),
    ...(input.locale ? { locale: input.locale.name } : {}),
    ...(input.messages ? { messages: input.messages } : {}),
    ...(input.manual ? { manual: input.manual } : {}),
    caseId: input.caseId,
    attempt: input.attempt,
    baseUrl: input.baseUrl,
    transport,
    masker,
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
  let record: AttemptRecord;
  try {
    const mod = (await import(pathToFileURL(input.specFile).href)) as SpecModule;
    if (mod.caseId !== input.caseId)
      throw new Error(`spec exports caseId ${JSON.stringify(mod.caseId)}, expected ${input.caseId}`);
    if (typeof mod.run !== "function") throw new Error("spec must export async function run(context)");
    const run = mod.run as (context: CaseContext) => Promise<void>;
    const pause = input.pause;
    const progress = input.progress;
    await withTimeout(
      (deadline) =>
        run(
          pause || progress
            ? {
                ...runtime.context,
                // REQ-EXEC-16/AC3: same pause as in the sandbox; the time limit stands still while it waits.
                step: async (stepId, fn) => {
                  if (pause) {
                    deadline.pause();
                    const answer = await pause(pausedStep(input.plan, input.caseId, stepId));
                    deadline.resume();
                    if (answer === "stop") throw new Error(`stopped by the tester before ${stepId}`);
                  }
                  progress?.step(stepId);
                  return runtime.context.step(stepId, fn);
                },
              }
            : runtime.context,
        ),
      input.timeoutMs,
    );
    record = await runtime.finish();
  } catch (error) {
    record = await runtime.finish(error);
  }
  const media = session ? await session.close(record.outcome !== "passed") : [];
  return { ...record, evidence: [...record.evidence, ...media] };
}
