import { applyAuditFinding, type AuditRecord, type CanaryRecord, type TestStatus } from "@qajitsu/core";

/** A case status after the auditor and the canary, with the reason of any downgrade. */
export interface CheckedStatus {
  readonly caseId: string;
  readonly status: TestStatus;
  /** Why the status was downgraded; undefined when unchanged. */
  readonly downgradedBy?: string | undefined;
}

/**
 * Applies the auditor and the canary to statuses computed from runner output (REQ-VER-06/AC2,
 * REQ-VER-09/AC2, invariant 5). Both can only move PASSED to NEEDS_REVIEW, never anything up:
 * - a finding `weak: true` downgrades that case;
 * - a failed audit in `required` mode downgrades every PASSED;
 * - a canary that passed (the inverted expectation was not caught) or could not run downgrades every PASSED;
 * - a record that is expected but missing, unreadable or changed after it was written downgrades every
 *   PASSED (fail closed: deleting a record must not bring back what it downgraded);
 * - a plan approved by a model only, in a project that reviews such results, or approval records that do not match
 *   the journal, downgrade every PASSED (REQ-PLAN-10/AC5).
 *
 * @param cases - Statuses computed by code.
 * @param audit - `checks/audit.json`, when an audit ran.
 * @param canary - `checks/canary.json`, when a canary ran.
 * @param integrity - Problems with the records themselves.
 * @param approval - Why every PASSED needs a person (REQ-PLAN-10/AC5): the plan was approved by a model only and the
 *   project set `approval.model_only: review`, or its approval records are not trustworthy.
 */
export function applyVerificationChecks(
  cases: readonly { readonly caseId: string; readonly status: TestStatus }[],
  audit?: AuditRecord,
  canary?: CanaryRecord,
  integrity: readonly string[] = [],
  approval?: string,
): CheckedStatus[] {
  return cases.map(({ caseId, status }) => {
    let reason: string | undefined;
    if (integrity.length > 0) reason = `verification records not trustworthy: ${integrity.join("; ")}`;
    else if (approval !== undefined) reason = approval;
    else if (canary?.status === "error") reason = `canary could not run: ${canary.detail}`;
    else if (canary?.status === "ran" && !canary.caught)
      reason = `canary not caught: ${canary.caseId} ${canary.stepId} ${canary.field} passed with an inverted expectation`;
    else if (audit?.status === "failed" && audit.mode === "required")
      reason = `required audit failed: ${audit.error}`;
    else if (audit?.status === "done") {
      const finding = audit.findings.find((f) => f.caseId === caseId && f.weak);
      if (finding) reason = `auditor: ${finding.reason}`;
    }
    const checked = applyAuditFinding(status, reason !== undefined);
    return checked === status ? { caseId, status } : { caseId, status: checked, downgradedBy: reason };
  });
}
