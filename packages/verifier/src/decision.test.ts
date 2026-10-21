import type { TestStatus } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { computeDecision, DEFAULT_DECISION_POLICY, formatDecision, type DecisionPolicy } from "./decision.js";

const c = (caseId: string, priority: "high" | "medium" | "low", status: TestStatus) =>
  ({ caseId, priority, status }) as const;

describe("GO / NO-GO decision (REQ-PUB-10)", () => {
  it("REQ-PUB-10/AC1+AC2: GO only when every case PASSED", () => {
    expect(computeDecision([c("TC-01", "high", "PASSED"), c("TC-02", "low", "PASSED")])).toEqual({
      decision: "GO",
      policyVersion: "1",
      causes: [],
      tolerated: [],
    });
  });

  it("REQ-PUB-10/AC2: a FAILED case is NO-GO; it outweighs cases that are only undecided", () => {
    const d = computeDecision([
      c("TC-01", "high", "FAILED"),
      c("TC-02", "high", "BLOCKED"),
      c("TC-03", "medium", "PASSED"),
    ]);
    expect(d.decision).toBe("NO-GO");
    expect(d.causes).toEqual([c("TC-01", "high", "FAILED")]);
    expect(formatDecision(d)).toBe("Decision: NO-GO (policy v1): TC-01 FAILED (high)");
  });

  it.each(["BLOCKED", "NOT_RUN", "NEEDS_REVIEW", "FLAKY"] as const)(
    "REQ-PUB-10/AC2: %s in a must-have case is NO DECISION, never GO",
    (status) => {
      const d = computeDecision([c("TC-01", "high", status), c("TC-02", "high", "PASSED")]);
      expect(d.decision).toBe("NO DECISION");
      expect(d.causes).toEqual([c("TC-01", "high", status)]);
    },
  );

  it("REQ-PUB-10/AC2: a run without cases is NO DECISION", () => {
    expect(computeDecision([]).decision).toBe("NO DECISION");
    expect(formatDecision(computeDecision([]))).toBe("Decision: NO DECISION (policy v1): no cases ran");
  });

  it("REQ-PUB-10/AC3: the policy may tolerate statuses of lower priorities, never of must-have cases; its version is recorded", () => {
    const policy: DecisionPolicy = {
      version: "2026-10",
      tolerate: { medium: ["NEEDS_REVIEW"], low: ["FAILED", "NOT_RUN"] },
    };
    const d = computeDecision(
      [c("TC-01", "high", "PASSED"), c("TC-02", "medium", "NEEDS_REVIEW"), c("TC-03", "low", "FAILED")],
      policy,
    );
    expect(d).toEqual({
      decision: "GO",
      policyVersion: "2026-10",
      causes: [],
      tolerated: [c("TC-02", "medium", "NEEDS_REVIEW"), c("TC-03", "low", "FAILED")],
    });
    expect(formatDecision(d)).toBe(
      "Decision: GO (policy v2026-10); tolerated by the policy: TC-02 NEEDS_REVIEW (medium), TC-03 FAILED (low)",
    );
    // A medium FAILED is not tolerated by this policy: NO-GO.
    expect(computeDecision([c("TC-01", "medium", "FAILED")], policy).decision).toBe("NO-GO");
    // A named version is shown as it is.
    expect(
      formatDecision(computeDecision([c("TC-01", "high", "PASSED")], { ...policy, version: "lab-1" })),
    ).toBe("Decision: GO (policy lab-1)");
    expect(DEFAULT_DECISION_POLICY).toEqual({ version: "1", tolerate: { medium: [], low: [] } });
  });
});
