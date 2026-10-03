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
}

/** Everything a runner reports for one test case; statuses are computed from this by code. */
export interface CaseRunResult {
  readonly caseId: string;
  readonly attempts: readonly CaseAttempt[];
}

/** Executes generated specs: API, web or mobile (REQ-EXEC-04..06). */
export interface Runner {
  readonly kind: "api" | "web" | "mobile";
  run(
    specFiles: readonly string[],
    context: { readonly runDir: string; readonly signal?: AbortSignal },
  ): Promise<readonly CaseRunResult[]>;
}
