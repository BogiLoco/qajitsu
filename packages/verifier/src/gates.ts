import type { TestStatus } from "@qajitsu/core";

/** Outcome of one publish gate (REQ-VER-07). */
export interface GateResult {
  readonly gate: string;
  readonly ok: boolean;
  readonly problems: readonly string[];
}

const result = (gate: string, problems: readonly string[]): GateResult => ({
  gate,
  ok: problems.length === 0,
  problems,
});

/**
 * Every case of the approved plan has exactly one status, and nothing outside the plan was reported
 * (REQ-PLAN-06, REQ-VER-07).
 *
 * @param approvedCaseIds - Case ids from `plan.approved.yaml`.
 * @param statuses - Computed statuses per case.
 */
export function gateEveryApprovedCaseHasOneStatus(
  approvedCaseIds: readonly string[],
  statuses: readonly { readonly caseId: string; readonly status: TestStatus }[],
): GateResult {
  const problems: string[] = [];
  const approved = new Set(approvedCaseIds);
  const counts = new Map<string, number>();
  for (const { caseId } of statuses) counts.set(caseId, (counts.get(caseId) ?? 0) + 1);

  for (const id of approved) {
    const count = counts.get(id) ?? 0;
    if (count === 0) problems.push(`${id}: no status (approved case was not reported)`);
    if (count > 1) problems.push(`${id}: ${count} statuses reported, expected exactly one`);
  }
  for (const id of counts.keys()) {
    if (!approved.has(id)) problems.push(`${id}: not in the approved plan`);
  }
  return result("every-approved-case-has-one-status", problems);
}

/**
 * The approved plan on disk is the one that was approved (REQ-PLAN-06, invariant 3).
 *
 * @param approvedSha256 - Hash recorded at approval time.
 * @param currentSha256 - Hash of `plan.approved.yaml` now.
 */
export function gateApprovedPlanUnchanged(approvedSha256: string, currentSha256: string): GateResult {
  return result(
    "approved-plan-unchanged",
    approvedSha256 === currentSha256 && approvedSha256.length > 0
      ? []
      : [
          `approved plan hash mismatch (approved ${approvedSha256 || "<none>"}, now ${currentSha256 || "<none>"})`,
        ],
  );
}

/**
 * Combines gate results. Publishing is allowed only when every gate passed.
 *
 * @param results - Results of all gates that ran.
 * @returns `ok` and the failed gates; an empty list is not ok, because nothing was checked.
 */
export function combineGates(results: readonly GateResult[]): {
  readonly ok: boolean;
  readonly failed: readonly GateResult[];
} {
  const failed = results.filter((r) => !r.ok);
  return { ok: results.length > 0 && failed.length === 0, failed };
}
