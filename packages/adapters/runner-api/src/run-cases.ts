import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CaseResultFileSchema,
  type CaseResultFile,
  type EventLog,
  type EvidenceStore,
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
  }>;
  /** Retries after a failed or errored attempt (REQ-EXEC-08/AC1, default 1). */
  readonly retries?: number;
  readonly timeoutMs?: number;
  readonly events: EventLog;
  readonly now: () => Date;
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
      const call = JSON.parse(item.content) as {
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

/**
 * Executes approved cases and writes `results/<case>.json` plus evidence for every attempt
 * (REQ-EXEC-04, REQ-EXEC-08, REQ-EVD-01/AC3). Cases without a spec get a `skipped` attempt (NOT_RUN).
 * Statuses are not decided here: the verifier computes them from these files (invariant 1).
 *
 * @returns The results per case id.
 */
export async function runCases(options: RunCasesOptions): Promise<Map<string, CaseResultFile>> {
  const retries = options.retries ?? 1;
  await mkdir(options.resultsDir, { recursive: true });
  const out = new Map<string, CaseResultFile>();
  for (const planCase of options.plan.cases) {
    const spec = options.specs.get(planCase.id);
    const attempts: CaseResultFile["attempts"] = [];
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
      for (let attempt = 1; attempt <= 1 + retries; attempt += 1) {
        const started = options.now();
        options.events.emit("run", { kind: "runner", name: "api" }, "case.attempt.start", {
          caseId: planCase.id,
          attempt,
        });
        let session;
        try {
          session = await options.login();
        } catch (error) {
          attempts.push({
            attempt,
            outcome: "error",
            assertions: [],
            error: `login failed: ${error instanceof Error ? error.message : String(error)}`,
            steps: [],
            evidence: [],
          });
          continue;
        }
        const executed: AttemptRecord = await options.executor({
          specFile: spec,
          caseId: planCase.id,
          attempt,
          plan: options.plan,
          baseUrl: options.baseUrl,
          allowedOrigins: options.allowedOrigins,
          accounts: session.accounts,
          secrets: session.secrets,
          timeoutMs: options.timeoutMs ?? 60_000,
        });
        const record = applyContract(executed, options.contract);
        const evidencePaths: string[] = [];
        for (const item of record.evidence) {
          const stored = await options.evidence.put(
            {
              path: `${planCase.id}/attempt-${String(attempt)}/${item.name}`,
              caseId: planCase.id,
              stepId: item.stepId,
              kind: item.kind,
            },
            new TextEncoder().encode(item.content),
          );
          evidencePaths.push(stored.path);
        }
        for (const step of record.steps) {
          options.events.emit("run", { kind: "runner", name: "api" }, "step", {
            caseId: planCase.id,
            attempt,
            step: step.id,
            ok: step.ok,
          });
        }
        for (const a of record.assertions) {
          options.events.emit("run", { kind: "runner", name: "api" }, "verify", {
            caseId: planCase.id,
            attempt,
            step: a.stepId,
            field: a.field,
            pass: a.pass,
          });
        }
        attempts.push({
          attempt,
          outcome: record.outcome,
          assertions: [...record.assertions],
          ...(record.error === undefined ? {} : { error: record.error }),
          steps: [...record.steps],
          evidence: evidencePaths,
          startedAt: started.toISOString(),
          durationMs: options.now().getTime() - started.getTime(),
        });
        options.events.emit("run", { kind: "runner", name: "api" }, "case.attempt.end", {
          caseId: planCase.id,
          attempt,
          outcome: record.outcome,
        });
        if (record.outcome === "passed") break;
      }
    }
    const result = CaseResultFileSchema.parse({
      schema: 1,
      caseId: planCase.id,
      runner: "api",
      ...(spec ? { spec } : {}),
      attempts,
    });
    await writeFile(join(options.resultsDir, `${planCase.id}.json`), `${JSON.stringify(result, null, 2)}\n`, {
      flag: "wx",
    });
    out.set(planCase.id, result);
  }
  return out;
}
