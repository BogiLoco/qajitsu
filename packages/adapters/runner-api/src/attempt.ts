import { pathToFileURL } from "node:url";
import type { Plan } from "@qajitsu/core";
import {
  createCaseRuntime,
  createMasker,
  type ApiTransport,
  type AttemptRecord,
  type CaseContext,
} from "@qajitsu/steps";

/** Everything one attempt needs; sent to the sandboxed child over IPC. Never contains raw config secrets. */
export interface AttemptInput {
  readonly specFile: string;
  readonly caseId: string;
  readonly attempt: number;
  readonly plan: Plan;
  readonly baseUrl: string;
  readonly allowedOrigins: readonly string[];
  /** Headers per account alias, from the framework login helper (REQ-CFG-07/AC2). */
  readonly accounts: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Values the child's masker must hide (session tokens, passwords). */
  readonly secrets: readonly string[];
  readonly timeoutMs: number;
}

/** Shape a spec module must export. */
interface SpecModule {
  readonly caseId?: unknown;
  readonly run?: unknown;
}

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`case timed out after ${String(ms)} ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Runs one attempt of one spec: imports it, checks it belongs to the case, runs `run(context)` and
 * returns what was recorded. Used inside the sandboxed child process and by in-process tests.
 *
 * @param input - Attempt settings.
 * @param transport - HTTP transport (Playwright in production).
 * @param now - Clock in milliseconds.
 */
export async function executeAttempt(
  input: AttemptInput,
  transport: ApiTransport,
  now: () => number = Date.now,
): Promise<AttemptRecord> {
  const masker = createMasker({ secrets: input.secrets });
  const runtime = createCaseRuntime({
    plan: input.plan,
    caseId: input.caseId,
    attempt: input.attempt,
    baseUrl: input.baseUrl,
    transport,
    masker,
    allowedOrigins: input.allowedOrigins,
    accounts: input.accounts,
    now,
  });
  try {
    const mod = (await import(pathToFileURL(input.specFile).href)) as SpecModule;
    if (mod.caseId !== input.caseId)
      throw new Error(`spec exports caseId ${JSON.stringify(mod.caseId)}, expected ${input.caseId}`);
    if (typeof mod.run !== "function") throw new Error("spec must export async function run(context)");
    const run = mod.run as (context: CaseContext) => Promise<void>;
    await withTimeout(run(runtime.context), input.timeoutMs);
    return runtime.finish();
  } catch (error) {
    return runtime.finish(error);
  }
}
