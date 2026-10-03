import { z } from "zod";
import { assertNever } from "./errors.js";

/**
 * All test case statuses (REQ-VER-01). The list is closed: adding a status is a breaking change
 * that needs an ADR, because reports, gates and CI exit codes depend on it.
 */
export const TEST_STATUSES = ["PASSED", "FAILED", "FLAKY", "BLOCKED", "NOT_RUN", "NEEDS_REVIEW"] as const;

/** Status of one test case from the approved plan. */
export type TestStatus = (typeof TEST_STATUSES)[number];

/** Zod schema for {@link TestStatus}. */
export const TestStatusSchema = z.enum(TEST_STATUSES);

/**
 * Applies an auditor finding to a status. The auditor can only downgrade PASSED to NEEDS_REVIEW
 * and can never improve a status (REQ-VER-06, invariant 5).
 *
 * @param status - Status computed from runner output.
 * @param auditorFoundInconsistency - Whether the auditor flagged the case.
 * @returns The resulting status.
 */
export function applyAuditFinding(status: TestStatus, auditorFoundInconsistency: boolean): TestStatus {
  if (!auditorFoundInconsistency) return status;
  switch (status) {
    case "PASSED":
      return "NEEDS_REVIEW";
    case "FAILED":
    case "FLAKY":
    case "BLOCKED":
    case "NOT_RUN":
    case "NEEDS_REVIEW":
      return status;
    default:
      return assertNever(status);
  }
}

/**
 * CLI exit code for a set of statuses (REQ-CI-04): 0 all passed, 1 any failed,
 * 2 no failures but blocked, flaky, not run or needing review.
 *
 * @param statuses - Statuses of all cases in the approved plan.
 * @returns 0, 1 or 2. An empty list returns 2, because nothing was proven.
 */
export function exitCodeFor(statuses: readonly TestStatus[]): 0 | 1 | 2 {
  if (statuses.length === 0) return 2;
  if (statuses.includes("FAILED")) return 1;
  return statuses.every((s) => s === "PASSED") ? 0 : 2;
}
