import { describe, expect, it } from "vitest";
import { combineGates, gateApprovedPlanUnchanged, gateEveryApprovedCaseHasOneStatus } from "./gates.js";

describe("gateEveryApprovedCaseHasOneStatus (REQ-VER-07)", () => {
  it("passes when each approved case has exactly one status", () => {
    const gate = gateEveryApprovedCaseHasOneStatus(
      ["TC-01", "TC-02"],
      [
        { caseId: "TC-01", status: "PASSED" },
        { caseId: "TC-02", status: "FAILED" },
      ],
    );
    expect(gate).toEqual({ gate: "every-approved-case-has-one-status", ok: true, problems: [] });
  });

  it("reports missing, duplicated and unapproved cases", () => {
    const gate = gateEveryApprovedCaseHasOneStatus(
      ["TC-01", "TC-02"],
      [
        { caseId: "TC-01", status: "PASSED" },
        { caseId: "TC-01", status: "FAILED" },
        { caseId: "TC-99", status: "PASSED" },
      ],
    );
    expect(gate.ok).toBe(false);
    expect(gate.problems).toEqual([
      "TC-01: 2 statuses reported, expected exactly one",
      "TC-02: no status (approved case was not reported)",
      "TC-99: not in the approved plan",
    ]);
  });
});

describe("gateApprovedPlanUnchanged (REQ-PLAN-06)", () => {
  it("passes on equal hashes", () => {
    expect(gateApprovedPlanUnchanged("abc", "abc").ok).toBe(true);
  });
  it("fails on mismatch or missing hash", () => {
    expect(gateApprovedPlanUnchanged("abc", "def").ok).toBe(false);
    expect(gateApprovedPlanUnchanged("", "").problems[0]).toContain("<none>");
  });
});

describe("combineGates", () => {
  it("is ok only when all gates passed", () => {
    const pass = gateApprovedPlanUnchanged("a", "a");
    const fail = gateApprovedPlanUnchanged("a", "b");
    expect(combineGates([pass]).ok).toBe(true);
    expect(combineGates([pass, fail])).toEqual({ ok: false, failed: [fail] });
  });
  it("is not ok when no gate ran", () => {
    expect(combineGates([]).ok).toBe(false);
  });
});
