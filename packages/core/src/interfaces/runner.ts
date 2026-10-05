import type { Plan } from "../plan/schemas.js";

/** Raw outcome of one assertion as recorded by `verify()` (REQ-EXEC-02). */
export interface AssertionRecord {
  readonly stepId: string;
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly pass: boolean;
}

/** Raw outcome of one attempt of one test case, as produced by a runner (REQ-VER-02). */
export interface CaseAttempt {
  readonly attempt: number;
  readonly outcome: "passed" | "failed" | "error" | "skipped";
  readonly assertions: readonly AssertionRecord[];
  readonly error?: string | undefined;
  /** The attempt ran a spec changed by the healer (REQ-EXEC-09). */
  readonly healed?: boolean | undefined;
}

/** Everything a runner reports for one test case; statuses are computed from this by code. */
export interface CaseRunResult {
  readonly caseId: string;
  readonly attempts: readonly CaseAttempt[];
}

/** One evidence item produced by an attempt, before it is stored. */
export interface EvidenceItem {
  /** Plan step, or `case` for evidence of the whole attempt (video, trace, HAR, console log). */
  readonly stepId: string;
  readonly kind: "request" | "response" | "screenshot" | "video" | "trace" | "log" | "har" | "dom";
  /** File name inside the attempt folder: `S1-01.json`, `S1.png`, `failure.png`, `video.webm`. */
  readonly name: string;
  readonly content: string | Uint8Array;
}

/** Everything one attempt produced, recorded by the trusted parent (ADR-0004); statuses are computed from it. */
export interface AttemptRecord {
  readonly caseId: string;
  readonly attempt: number;
  readonly outcome: "passed" | "failed" | "error";
  readonly error?: string;
  /** Steps in order; `url` is the page at the end of a step that used the browser (REQ-OBS-06). */
  readonly steps: readonly {
    readonly id: string;
    readonly ok: boolean;
    readonly error?: string;
    readonly url?: string;
  }[];
  readonly assertions: readonly AssertionRecord[];
  readonly evidence: readonly EvidenceItem[];
}

/** One attempt of one case of the approved plan (REQ-EXEC-04..06). */
export interface AttemptRequest {
  readonly specFile: string;
  readonly caseId: string;
  readonly attempt: number;
  readonly plan: Plan;
  readonly baseUrl: string;
  readonly allowedOrigins: readonly string[];
  /** Headers per account alias, from the framework login helper (REQ-CFG-07/AC2). */
  readonly accounts: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Values the masker must hide (session tokens, passwords). */
  readonly secrets: readonly string[];
  readonly timeoutMs: number;
  /** Raw session tokens per alias for the browser (never sent to the spec; REQ-CFG-07). */
  readonly sessions?: Readonly<Record<string, string>>;
}

/**
 * Executes one attempt of one case: the runner seam (REQ-GEN-02, ADR-0005). The production implementation runs
 * the spec sandboxed while the trusted parent performs every call and records every assertion (ADR-0004); web and
 * mobile give it a browser or device factory. It never decides a status: that is computed from the record.
 */
export type AttemptExecutor = (request: AttemptRequest) => Promise<AttemptRecord>;
