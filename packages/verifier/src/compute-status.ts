import type { CaseAttempt, CaseRunResult, TestStatus } from "@qajitsu/core";

/** Facts about a case that do not come from the runner result itself. */
export interface StatusContext {
  /** Every step of the case has evidence listed in the manifest with a matching hash (REQ-VER-05). */
  readonly evidenceComplete: boolean;
}

const attemptFailed = (attempt: CaseAttempt): boolean =>
  attempt.outcome === "failed" || attempt.assertions.some((a) => !a.pass);

const attemptPassed = (attempt: CaseAttempt): boolean =>
  attempt.outcome === "passed" && attempt.assertions.length > 0 && attempt.assertions.every((a) => a.pass);

/**
 * Computes the status of one test case from raw runner output. This is the only place statuses
 * are decided (REQ-VER-01, REQ-VER-02, invariant 1). Fail-closed: anything ambiguous never becomes PASSED.
 *
 * Rules, in order:
 * 1. No attempts, or the last attempt was skipped → NOT_RUN.
 * 2. The last attempt errored (could not execute) → FAILED when an earlier attempt observed a failed
 *    assertion (a crash on retry must not hide a defect), otherwise BLOCKED.
 * 2b. A passing last attempt that ran a healed spec → NEEDS_REVIEW: an agent changed the test, so a
 *    human reviews the heal; a heal never yields PASSED (REQ-EXEC-09/AC3).
 * 3. The first attempt passed with at least one assertion and all assertions true →
 *    PASSED when evidence is complete, otherwise NEEDS_REVIEW.
 * 4. A later attempt passed after an earlier failure → FLAKY (REQ-EXEC-08).
 * 5. An attempt reported "passed" without assertions → NEEDS_REVIEW (nothing was verified).
 * 6. Otherwise → FAILED. A runner saying "passed" while an assertion failed counts as failed.
 *
 * @param result - Attempts reported by the runner for one case.
 * @param context - Evidence completeness from the manifest check.
 * @returns The case status.
 */
export function computeStatus(result: CaseRunResult, context: StatusContext): TestStatus {
  const { attempts } = result;
  const first = attempts[0];
  const last = attempts.at(-1);
  if (first === undefined || last === undefined || last.outcome === "skipped") return "NOT_RUN";
  if (last.outcome === "error")
    return attempts.some((a) => a.assertions.some((x) => !x.pass)) ? "FAILED" : "BLOCKED";
  if (attempts.some((a) => a.healed === true) && attemptPassed(last)) return "NEEDS_REVIEW";
  if (attemptPassed(first)) return context.evidenceComplete ? "PASSED" : "NEEDS_REVIEW";
  if (attemptPassed(last) && attempts.some(attemptFailed)) return "FLAKY";
  if (
    attempts.some((a) => a.outcome === "passed" && a.assertions.length === 0) &&
    !attempts.some(attemptFailed)
  ) {
    return "NEEDS_REVIEW";
  }
  return "FAILED";
}
