import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CaseResultFileSchema,
  sha256,
  type CaseResultFile,
  type EventLog,
  type EvidenceStore,
  type ManualPrompter,
  type VisualCheck,
  type CaseMessages,
  type Plan,
} from "@qajitsu/core";
import type { AttemptRecord } from "@qajitsu/steps";
import type { AttemptInput } from "./attempt.js";
import type { ContractValidator } from "./openapi.js";
import type { AttemptExecutor } from "./sandbox.js";

/** Settings of one execution. */
export interface RunCasesOptions {
  readonly plan: Plan;
  /** Spec file per case id, already filtered to approved cases (REQ-PLAN-06/AC4). */
  readonly specs: ReadonlyMap<string, string>;
  readonly executor: AttemptExecutor;
  readonly evidence: EvidenceStore;
  readonly resultsDir: string;
  readonly baseUrl: string;
  readonly allowedOrigins: readonly string[];
  /**
   * Logs in every account alias for one attempt. Called per attempt, so retries never share session
   * state (carts, tokens) with the attempt before them (REQ-EXEC-08, REQ-CFG-07/AC2).
   */
  readonly login: () => Promise<{
    readonly accounts: AttemptInput["accounts"];
    readonly secrets: readonly string[];
    readonly sessions?: Readonly<Record<string, string>>;
  }>;
  /** Retries after a failed or errored attempt (REQ-EXEC-08/AC1, default 1). */
  readonly retries?: number;
  readonly timeoutMs?: number;
  readonly events: EventLog;
  readonly now: () => Date;
  /**
   * Healer for cases that could not run (selector or wait errors): returns a healed spec, or undefined.
   * Called at most twice per case; healed attempts are marked and never yield PASSED (REQ-EXEC-09).
   */
  readonly heal?: (
    caseId: string,
    specFile: string,
    failed: AttemptRecord,
    healAttempt: number,
  ) => Promise<string | undefined>;
  /** Cases running at the same time (REQ-EXEC-10/AC1, default 1). */
  readonly workers?: number;
  /** Asks a person at manual steps (REQ-EXEC-11); without it manual steps end the attempt as an error. */
  readonly manual?: ManualPrompter | undefined;
  /** How long one manual step may wait for its answer (default 15 minutes). */
  readonly manualTimeoutMs?: number;
  /** Checked before each case; a reason leaves the case NOT_RUN with it (REQ-PLAN-08/AC3, a time budget). */
  readonly stopReason?: (() => string | undefined) | undefined;
  /** Baselines and image comparison of this run's variant (REQ-EXEC-12). */
  readonly visual?: VisualCheck | undefined;
  /** Locale and time zone of a locale run (REQ-EXEC-14); `plan` must be resolved for it. */
  readonly locale?: { readonly name: string; readonly timezone: string } | undefined;
  /** Prefix of evidence paths, e.g. `matrix/firefox-mobile/` for a browser combination (REQ-EXEC-13). */
  readonly evidencePrefix?: string;
  /** The message inbox of a case (REQ-ENV-08), created on first use and shared by its attempts. */
  readonly messages?: ((caseId: string) => CaseMessages) | undefined;
  /** OpenAPI contract of the application; responses that violate it fail the step (REQ-EXEC-04/AC2). */
  readonly contract?: ContractValidator | undefined;
}

/**
 * Adds a failed assertion for every recorded response that violates the contract. Passing contract
 * checks are not added: they must never count as the `verify()` a PASSED case needs.
 */
export function applyContract(record: AttemptRecord, contract: ContractValidator | undefined): AttemptRecord {
  if (!contract) return record;
  const violations = record.evidence.flatMap((item) => {
    try {
      const call = JSON.parse(typeof item.content === "string" ? item.content : "") as {
        method?: string;
        url?: string;
        response?: { status?: number; body?: unknown };
      };
      if (!call.method || !call.url || typeof call.response?.status !== "number") return [];
      const problems = contract.check(call.method, call.url, call.response.status, call.response.body) ?? [];
      return problems.map((p) => ({
        stepId: item.stepId,
        field: "openapi",
        expected: "response matches the OpenAPI document",
        actual: p,
        pass: false,
      }));
    } catch {
      return [];
    }
  });
  if (violations.length === 0) return record;
  return { ...record, outcome: "failed", assertions: [...record.assertions, ...violations] };
}

type Attempt = CaseResultFile["attempts"][number];

/**
 * Executes approved cases and writes `results/<case>.json` plus evidence for every attempt
 * (REQ-EXEC-04, REQ-EXEC-08, REQ-EVD-01/AC3). Cases without a spec get a `skipped` attempt (NOT_RUN).
 * Up to `workers` cases run at the same time (REQ-EXEC-10). Statuses are not decided here: the
 * verifier computes them from these files (invariant 1).
 *
 * @returns The results per case id.
 */
export async function runCases(options: RunCasesOptions): Promise<Map<string, CaseResultFile>> {
  const retries = options.retries ?? 1;
  await mkdir(options.resultsDir, { recursive: true });
  const actor = { kind: "runner", name: "api" } as const;

  const manualCount = (caseId: string): number =>
    options.plan.cases.find((c) => c.id === caseId)?.steps.filter((st) => st.manual === true).length ?? 0;

  /** Message steps wait for their message (REQ-ENV-08): the attempt's time limit grows by those waits. */
  const messageWaitMs = (caseId: string): number => {
    const service = options.messages?.(caseId);
    return (options.plan.cases.find((c) => c.id === caseId)?.steps ?? []).reduce(
      (ms, st) =>
        st.expect.message ? ms + (st.expect.message.within_s ?? (service?.timeoutMs ?? 0) / 1000) * 1000 : ms,
      0,
    );
  };

  const runAttempt = async (
    caseId: string,
    spec: string,
    attempt: number,
    healed: boolean,
  ): Promise<{ entry: Attempt; record?: AttemptRecord }> => {
    const started = options.now();
    // REQ-PUB-08/AC2: which spec ran is recorded by the runner, so only that exact code can be promoted.
    const specSha256 = await readFile(spec).then(
      (bytes) => sha256(bytes),
      () => undefined,
    );
    options.events.emit("run", actor, "case.attempt.start", {
      caseId,
      attempt,
      healed,
      ...(specSha256 === undefined ? {} : { specSha256 }),
    });
    let session;
    try {
      session = await options.login();
    } catch (error) {
      return {
        entry: {
          attempt,
          outcome: "error",
          assertions: [],
          error: `login failed: ${error instanceof Error ? error.message : String(error)}`,
          steps: [],
          evidence: [],
        },
      };
    }
    const executed = await options.executor({
      specFile: spec,
      caseId,
      attempt,
      plan: options.plan,
      baseUrl: options.baseUrl,
      allowedOrigins: options.allowedOrigins,
      accounts: session.accounts,
      secrets: session.secrets,
      ...(session.sessions ? { sessions: session.sessions } : {}),
      // A case with manual steps waits for people: its time limit grows by their answer time (REQ-EXEC-11).
      timeoutMs:
        (options.timeoutMs ?? 60_000) +
        manualCount(caseId) * (options.manualTimeoutMs ?? 900_000) +
        messageWaitMs(caseId),
      ...(options.manual ? { manual: options.manual } : {}),
      ...(options.locale ? { locale: options.locale } : {}),
      ...(options.visual ? { visual: options.visual } : {}),
      ...(options.messages ? { messages: options.messages(caseId) } : {}),
    });
    const record = applyContract(executed, options.contract);
    const evidencePaths: string[] = [];
    for (const item of record.evidence) {
      const stored = await options.evidence.put(
        {
          path: `${options.evidencePrefix ?? ""}${caseId}/attempt-${String(attempt)}/${item.name}`,
          caseId,
          stepId: item.stepId,
          kind: item.kind,
        },
        typeof item.content === "string" ? new TextEncoder().encode(item.content) : item.content,
      );
      evidencePaths.push(stored.path);
    }
    for (const step of record.steps)
      options.events.emit("run", actor, "step", { caseId, attempt, step: step.id, ok: step.ok });
    for (const a of record.assertions)
      options.events.emit("run", actor, "verify", {
        caseId,
        attempt,
        step: a.stepId,
        field: a.field,
        pass: a.pass,
      });
    options.events.emit("run", actor, "case.attempt.end", {
      caseId,
      attempt,
      outcome: record.outcome,
      healed,
    });
    return {
      record,
      entry: {
        attempt,
        outcome: record.outcome,
        assertions: [...record.assertions],
        ...(record.error === undefined ? {} : { error: record.error }),
        steps: [...record.steps],
        evidence: evidencePaths,
        startedAt: started.toISOString(),
        durationMs: options.now().getTime() - started.getTime(),
        ...(healed ? { healed: true } : {}),
        ...(specSha256 === undefined ? {} : { specSha256 }),
      },
    };
  };

  const runCase = async (caseId: string): Promise<CaseResultFile> => {
    const stop = options.stopReason?.();
    if (stop !== undefined) {
      options.events.emit("run", actor, "case.not_run", { caseId, reason: stop });
      const skipped = CaseResultFileSchema.parse({
        schema: 1,
        caseId,
        runner: "api",
        attempts: [{ attempt: 1, outcome: "skipped", assertions: [], error: stop, steps: [], evidence: [] }],
      });
      await writeFile(join(options.resultsDir, `${caseId}.json`), `${JSON.stringify(skipped, null, 2)}\n`, {
        flag: "wx",
      });
      return skipped;
    }
    const spec = options.specs.get(caseId);
    const attempts: Attempt[] = [];
    if (spec === undefined) {
      attempts.push({
        attempt: 1,
        outcome: "skipped",
        assertions: [],
        error: "no executable spec for this case",
        steps: [],
        evidence: [],
      });
    } else {
      let last: AttemptRecord | undefined;
      // REQ-EXEC-11: a person is never asked twice; cases with manual steps are not retried or healed.
      const manual = manualCount(caseId) > 0;
      for (let attempt = 1; attempt <= 1 + (manual ? 0 : retries); attempt += 1) {
        const { entry, record } = await runAttempt(caseId, spec, attempt, false);
        attempts.push(entry);
        last = record;
        if (entry.outcome === "passed") break;
      }
      // REQ-EXEC-09: only a case that could not run (error, not a failed assertion) is healed.
      for (let heal = 1; !manual && options.heal && last?.outcome === "error" && heal <= 2; heal += 1) {
        const healedSpec = await options.heal(caseId, spec, last, heal);
        if (healedSpec === undefined) break;
        const { entry, record } = await runAttempt(caseId, healedSpec, attempts.length + 1, true);
        attempts.push(entry);
        last = record;
      }
    }
    const result = CaseResultFileSchema.parse({
      schema: 1,
      caseId,
      runner: "api",
      ...(spec ? { spec } : {}),
      attempts,
    });
    await writeFile(join(options.resultsDir, `${caseId}.json`), `${JSON.stringify(result, null, 2)}\n`, {
      flag: "wx",
    });
    return result;
  };

  // REQ-EXEC-10/AC1: a pool of workers; each case still runs its attempts in order.
  const ids = options.plan.cases.map((c) => c.id);
  const out = new Map<string, CaseResultFile>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      const id = ids[next];
      next += 1;
      if (id !== undefined) out.set(id, await runCase(id));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.workers ?? 1, ids.length)) }, worker));
  return new Map(
    ids.flatMap((id) => {
      const r = out.get(id);
      return r ? [[id, r] as const] : [];
    }),
  );
}
