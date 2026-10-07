import type { TestStatus } from "@qajitsu/core";

/** Worst first: an observed failure outranks everything; PASSED needs every combination to pass. */
const ORDER: readonly TestStatus[] = ["FAILED", "FLAKY", "BLOCKED", "NEEDS_REVIEW", "NOT_RUN", "PASSED"];

/**
 * The status of a case run in several browser and viewport combinations (REQ-EXEC-13/AC2): PASSED only when every
 * combination is PASSED, otherwise the worst status (FAILED, FLAKY, BLOCKED, NEEDS_REVIEW, NOT_RUN). No combination
 * at all is NOT_RUN. Each combination's status is computed by `computeStatus` first (invariant 1).
 *
 * @param statuses - One computed status per combination.
 */
export function combineStatuses(statuses: readonly TestStatus[]): TestStatus {
  if (statuses.length === 0) return "NOT_RUN";
  return ORDER.find((s) => statuses.includes(s)) ?? "NOT_RUN";
}
