/** One reproduction case on both versions, as computed by code from each run's results (REQ-VER-11). */
export interface FixCheckInput {
  readonly caseId: string;
  /** Status on the version before the fix; `missing` when the case has no result there. */
  readonly before: string;
  /** Status on the version with the fix. */
  readonly after: string;
  /** SHA-256 of the spec executed before and after. */
  readonly specBefore: string;
  readonly specAfter: string;
}

/** The verdict of one reproduction case. */
export interface FixCheckCase extends FixCheckInput {
  readonly verified: boolean;
  readonly reason: string;
}

/**
 * Decides whether a bug fix is verified (REQ-VER-11/AC3): every reproduction case must be FAILED on the version
 * before the fix and PASSED with it, with the same spec on both (AC2). Anything else (passed before, failed after,
 * BLOCKED, FLAKY, NOT_RUN, NEEDS_REVIEW or a missing result on either side) is not verified, with the reason. No
 * reproduction case means nothing was verified. Pure function on computed statuses (invariant 1).
 *
 * @param cases - Reproduction cases with their statuses and spec hashes on both versions.
 */
export function evaluateFixCheck(cases: readonly FixCheckInput[]): {
  readonly verified: boolean;
  readonly cases: readonly FixCheckCase[];
} {
  const judged = cases.map((c): FixCheckCase => {
    const reason =
      c.specBefore !== c.specAfter
        ? "the spec differs between the two versions"
        : c.before === "PASSED"
          ? "passed before the fix: the test does not reproduce the bug"
          : c.after === "FAILED"
            ? "still FAILED with the fix"
            : c.before !== "FAILED"
              ? `before the fix ${c.before}: not conclusive, it must be FAILED`
              : c.after !== "PASSED"
                ? `with the fix ${c.after}: not conclusive, it must be PASSED`
                : undefined;
    return {
      ...c,
      verified: reason === undefined,
      reason: reason ?? "failed before the fix and passed with it",
    };
  });
  return { verified: judged.length > 0 && judged.every((c) => c.verified), cases: judged };
}
