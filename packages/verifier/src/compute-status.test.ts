import type { AssertionRecord, CaseAttempt } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { computeStatus } from "./compute-status.js";

const ok: AssertionRecord = { stepId: "S1", field: "status", expected: 201, actual: 201, pass: true };
const bad: AssertionRecord = { stepId: "S1", field: "status", expected: 201, actual: 500, pass: false };

const attempt = (outcome: CaseAttempt["outcome"], assertions: AssertionRecord[], n = 1): CaseAttempt => ({
  attempt: n,
  outcome,
  assertions,
});

const status = (attempts: CaseAttempt[], evidenceComplete = true) =>
  computeStatus({ caseId: "TC-01", attempts }, { evidenceComplete });

describe("computeStatus (REQ-VER-01, REQ-VER-02)", () => {
  it("PASSED: first attempt passed with assertions and complete evidence", () => {
    expect(status([attempt("passed", [ok])])).toBe("PASSED");
  });

  it("NEEDS_REVIEW: passed but evidence incomplete (REQ-VER-05)", () => {
    expect(status([attempt("passed", [ok])], false)).toBe("NEEDS_REVIEW");
  });

  it("FAILED: an assertion failed", () => {
    expect(status([attempt("failed", [ok, bad])])).toBe("FAILED");
  });

  it("FAILED: runner says passed but an assertion failed", () => {
    expect(status([attempt("passed", [bad])])).toBe("FAILED");
  });

  it("FLAKY: failed first, passed on retry (REQ-EXEC-08)", () => {
    expect(status([attempt("failed", [bad], 1), attempt("passed", [ok], 2)])).toBe("FLAKY");
  });

  it("FAILED: failed on every attempt", () => {
    expect(status([attempt("failed", [bad], 1), attempt("failed", [bad], 2)])).toBe("FAILED");
  });

  it("BLOCKED: last attempt could not execute", () => {
    expect(status([attempt("error", [])])).toBe("BLOCKED");
    // Deliberately stricter since the stage-3 integrity review: a crash on retry must not hide the
    // failed assertion observed before it, so this is FAILED (see the "FAILED" case below).
    expect(status([attempt("failed", [bad], 1), attempt("error", [], 2)])).toBe("FAILED");
  });

  it("NOT_RUN: no attempts or skipped", () => {
    expect(status([])).toBe("NOT_RUN");
    expect(status([attempt("skipped", [])])).toBe("NOT_RUN");
  });

  it("NEEDS_REVIEW: passed without any assertion (nothing verified)", () => {
    expect(status([attempt("passed", [])])).toBe("NEEDS_REVIEW");
  });

  it("FAILED: no assertions on the first attempt but a failure later", () => {
    expect(status([attempt("passed", [], 1), attempt("failed", [bad], 2)])).toBe("FAILED");
  });
});

describe("assertions that need a person (REQ-EXEC-12/AC3)", () => {
  const review: AssertionRecord = {
    stepId: "S2",
    field: "visual",
    expected: { baseline: "k" },
    actual: "(no baseline)",
    pass: true,
    review: true,
  };
  it("REQ-EXEC-12/AC3: a passing attempt with a review assertion is NEEDS_REVIEW, never PASSED", () => {
    expect(status([attempt("passed", [ok, review])])).toBe("NEEDS_REVIEW");
  });
  it("REQ-EXEC-12/AC3: a review assertion never hides a failure", () => {
    expect(status([attempt("failed", [bad, review])])).toBe("FAILED");
  });
  it("REQ-EXEC-12/AC3: a flaky case stays FLAKY when it also needs review", () => {
    expect(status([attempt("failed", [bad], 1), attempt("passed", [ok, review], 2)])).toBe("FLAKY");
  });
});
