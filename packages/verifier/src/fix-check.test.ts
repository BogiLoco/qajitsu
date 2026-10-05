import { describe, expect, it } from "vitest";
import { evaluateFixCheck } from "./fix-check.js";

const c = (
  caseId: string,
  before: string,
  after: string,
  specBefore = "a".repeat(64),
  specAfter = specBefore,
) => ({
  caseId,
  before,
  after,
  specBefore,
  specAfter,
});

describe("fix verification: fails before, passes after (REQ-VER-11)", () => {
  it("REQ-VER-11/AC3: verified only when every reproduction case FAILED before and PASSED after", () => {
    expect(evaluateFixCheck([c("TC-01", "FAILED", "PASSED")])).toEqual({
      verified: true,
      cases: [
        {
          ...c("TC-01", "FAILED", "PASSED"),
          verified: true,
          reason: "failed before the fix and passed with it",
        },
      ],
    });
  });

  it.each([
    ["PASSED", "PASSED", "passed before the fix: the test does not reproduce the bug"],
    ["FAILED", "FAILED", "still FAILED with the fix"],
    ["BLOCKED", "PASSED", "before the fix BLOCKED: not conclusive, it must be FAILED"],
    ["FLAKY", "PASSED", "before the fix FLAKY: not conclusive, it must be FAILED"],
    ["FAILED", "FLAKY", "with the fix FLAKY: not conclusive, it must be PASSED"],
    ["FAILED", "NEEDS_REVIEW", "with the fix NEEDS_REVIEW: not conclusive, it must be PASSED"],
    ["NOT_RUN", "PASSED", "before the fix NOT_RUN: not conclusive, it must be FAILED"],
    ["FAILED", "missing", "with the fix missing: not conclusive, it must be PASSED"],
  ])("REQ-VER-11/AC3: %s before and %s after is not verified", (before, after, reason) => {
    const result = evaluateFixCheck([c("TC-01", before, after)]);
    expect(result.verified).toBe(false);
    expect(result.cases[0]).toMatchObject({ verified: false, reason });
  });

  it("REQ-VER-11/AC2 + invariant 3: different specs on the two versions are never a verification", () => {
    const result = evaluateFixCheck([c("TC-01", "FAILED", "PASSED", "a".repeat(64), "b".repeat(64))]);
    expect(result).toMatchObject({
      verified: false,
      cases: [{ verified: false, reason: "the spec differs between the two versions" }],
    });
  });

  it("REQ-VER-11/AC3: one unverified case or no reproduction case at all makes the fix unverified", () => {
    expect(evaluateFixCheck([c("TC-01", "FAILED", "PASSED"), c("TC-02", "PASSED", "PASSED")]).verified).toBe(
      false,
    );
    expect(evaluateFixCheck([]).verified).toBe(false);
  });
});
