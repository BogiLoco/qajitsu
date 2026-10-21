import type { TestStatus } from "@qajitsu/core";

/** The release decision of a run (REQ-PUB-10). */
export type ReleaseDecision = "GO" | "NO-GO" | "NO DECISION";

/** A case as the decision sees it: its priority from the plan and the status code computed. */
export interface DecisionCase {
  readonly caseId: string;
  readonly priority: "high" | "medium" | "low";
  readonly status: TestStatus;
}

/**
 * The project's decision policy (REQ-PUB-10/AC3): which statuses of medium and low priority cases do not stand in
 * the way of GO. Must-have (high priority) cases are never tolerated.
 */
export interface DecisionPolicy {
  readonly version: string;
  readonly tolerate: {
    readonly medium: readonly TestStatus[];
    readonly low: readonly TestStatus[];
  };
}

/** Default policy: GO only if every case PASSED. */
export const DEFAULT_DECISION_POLICY: DecisionPolicy = { version: "1", tolerate: { medium: [], low: [] } };

/** The computed decision with the cases that caused it. */
export interface DecisionResult {
  readonly decision: ReleaseDecision;
  readonly policyVersion: string;
  /** Cases that keep the run from GO. */
  readonly causes: readonly DecisionCase[];
  /** Cases that are not PASSED but that the policy tolerates. */
  readonly tolerated: readonly DecisionCase[];
}

/**
 * GO, NO-GO or NO DECISION, computed by code from the matrix and the policy (REQ-PUB-10/AC1+AC2): any FAILED that the
 * policy does not tolerate is NO-GO; otherwise any other status that is not PASSED and not tolerated is NO DECISION;
 * a run without cases is NO DECISION; everything else is GO.
 *
 * @param cases - Every case of the run with its priority and computed status.
 * @param policy - The project's decision policy.
 */
export function computeDecision(
  cases: readonly DecisionCase[],
  policy: DecisionPolicy = DEFAULT_DECISION_POLICY,
): DecisionResult {
  const tolerated = cases.filter(
    (c) => c.status !== "PASSED" && c.priority !== "high" && policy.tolerate[c.priority].includes(c.status),
  );
  const blocking = cases.filter((c) => c.status !== "PASSED" && !tolerated.includes(c));
  const failed = blocking.filter((c) => c.status === "FAILED");
  const decision: ReleaseDecision =
    cases.length === 0
      ? "NO DECISION"
      : failed.length > 0
        ? "NO-GO"
        : blocking.length > 0
          ? "NO DECISION"
          : "GO";
  return {
    decision,
    policyVersion: policy.version,
    causes: decision === "NO-GO" ? failed : decision === "NO DECISION" ? blocking : [],
    tolerated,
  };
}

/** The decision as one line for the matrix, the report and the ticket comment. */
export function formatDecision(d: DecisionResult): string {
  const list = (xs: readonly DecisionCase[]) =>
    xs.map((c) => `${c.caseId} ${c.status} (${c.priority})`).join(", ");
  // "policy v1" for a version number, "policy lab-1" for a name.
  const version = /^\d/.test(d.policyVersion) ? `v${d.policyVersion}` : d.policyVersion;
  const head = `Decision: ${d.decision} (policy ${version})`;
  if (d.decision === "GO")
    return d.tolerated.length > 0 ? `${head}; tolerated by the policy: ${list(d.tolerated)}` : head;
  return `${head}: ${d.causes.length > 0 ? list(d.causes) : "no cases ran"}`;
}
