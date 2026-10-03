import { describe, expect, it } from "vitest";
import { TEST_STATUSES, TestStatusSchema, applyAuditFinding, exitCodeFor } from "./status.js";

describe("statuses (REQ-VER-01)", () => {
  it("parses every known status and rejects others", () => {
    for (const status of TEST_STATUSES) expect(TestStatusSchema.parse(status)).toBe(status);
    expect(TestStatusSchema.safeParse("SUCCESS").success).toBe(false);
  });
});

describe("applyAuditFinding (REQ-VER-06)", () => {
  it("downgrades PASSED to NEEDS_REVIEW when the auditor flags a case", () => {
    expect(applyAuditFinding("PASSED", true)).toBe("NEEDS_REVIEW");
  });

  it("never upgrades any status", () => {
    for (const status of TEST_STATUSES) {
      if (status === "PASSED") continue;
      expect(applyAuditFinding(status, true)).toBe(status);
    }
  });

  it("leaves statuses unchanged without a finding", () => {
    for (const status of TEST_STATUSES) expect(applyAuditFinding(status, false)).toBe(status);
  });
});

describe("exitCodeFor (REQ-CI-04)", () => {
  it("returns 0 only when everything passed", () => {
    expect(exitCodeFor(["PASSED", "PASSED"])).toBe(0);
  });
  it("returns 1 when anything failed", () => {
    expect(exitCodeFor(["PASSED", "BLOCKED", "FAILED"])).toBe(1);
  });
  it("returns 2 for blocked, flaky, not run or needs review without failures", () => {
    expect(exitCodeFor(["PASSED", "FLAKY"])).toBe(2);
    expect(exitCodeFor(["NEEDS_REVIEW"])).toBe(2);
  });
  it("returns 2 for an empty run", () => {
    expect(exitCodeFor([])).toBe(2);
  });
});
