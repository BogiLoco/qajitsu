// Adversarial suite: broken runner output and auditor upgrades must never produce PASSED.
import { applyAuditFinding, TEST_STATUSES, type CaseAttempt } from "@qajitsu/core";
import { combineGates, computeStatus, gateEveryApprovedCaseHasOneStatus } from "@qajitsu/verifier";
import { describe, expect, it } from "vitest";

const attempt = (outcome: CaseAttempt["outcome"], pass: boolean[] = []): CaseAttempt => ({
  attempt: 1,
  outcome,
  assertions: pass.map((p, i) => ({
    stepId: `S${i + 1}`,
    field: "status",
    expected: 200,
    actual: p ? 200 : 500,
    pass: p,
  })),
});

describe("invariant 1: the verdict comes from assertions, not from claims (REQ-VER-02)", () => {
  it("runner claims passed while an assertion failed → FAILED", () => {
    expect(
      computeStatus(
        { caseId: "TC-01", attempts: [attempt("passed", [true, false])] },
        { evidenceComplete: true },
      ),
    ).toBe("FAILED");
  });

  it("runner claims passed without verifying anything → not PASSED", () => {
    expect(
      computeStatus({ caseId: "TC-01", attempts: [attempt("passed")] }, { evidenceComplete: true }),
    ).not.toBe("PASSED");
  });

  it("passed on retry is FLAKY, never PASSED (REQ-EXEC-08)", () => {
    const attempts = [attempt("failed", [false]), { ...attempt("passed", [true]), attempt: 2 }];
    expect(computeStatus({ caseId: "TC-01", attempts }, { evidenceComplete: true })).toBe("FLAKY");
  });

  it("missing evidence turns PASSED into NEEDS_REVIEW (REQ-VER-05)", () => {
    expect(
      computeStatus({ caseId: "TC-01", attempts: [attempt("passed", [true])] }, { evidenceComplete: false }),
    ).toBe("NEEDS_REVIEW");
  });
});

describe("invariant 5: the auditor can only downgrade (REQ-VER-06)", () => {
  it("no status ever becomes PASSED through an audit finding", () => {
    for (const status of TEST_STATUSES) {
      expect(applyAuditFinding(status, true)).not.toBe("PASSED");
    }
  });
});

describe("invariant 3: only the approved plan counts (REQ-PLAN-06, REQ-VER-07)", () => {
  it("an extra case smuggled into results fails the publish gate", () => {
    const gate = gateEveryApprovedCaseHasOneStatus(
      ["TC-01"],
      [
        { caseId: "TC-01", status: "FAILED" },
        { caseId: "TC-EXTRA", status: "PASSED" },
      ],
    );
    expect(combineGates([gate]).ok).toBe(false);
  });

  it("dropping a failed case from results fails the publish gate", () => {
    const gate = gateEveryApprovedCaseHasOneStatus(
      ["TC-01", "TC-02"],
      [{ caseId: "TC-01", status: "PASSED" }],
    );
    expect(gate.problems).toContain("TC-02: no status (approved case was not reported)");
  });
});
