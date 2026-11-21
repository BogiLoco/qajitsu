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

// Found by mutation testing (REQ-NFR-14): each rule on its own, with the case that only it decides.
describe("each status rule decides alone (REQ-VER-01, REQ-VER-02, REQ-NFR-14)", () => {
  const healed = (a: CaseAttempt, flag = true): CaseAttempt => ({ ...a, healed: flag });

  it("REQ-VER-02: a runner that reports failed fails the case even when every assertion held (a crash, a timeout)", () => {
    expect(status([attempt("failed", [ok])])).toBe("FAILED");
    expect(status([attempt("failed", [ok], 1), attempt("passed", [ok], 2)])).toBe("FLAKY");
  });

  it("REQ-VER-02: one failed assertion among passing ones fails the case, whatever the runner says", () => {
    expect(status([attempt("passed", [ok, bad])])).toBe("FAILED");
    expect(status([attempt("passed", [bad], 1), attempt("passed", [ok], 2)])).toBe("FLAKY");
  });

  it("REQ-VER-02: an attempt without assertions never hides a failed one", () => {
    expect(status([attempt("passed", [], 1), attempt("passed", [bad], 2)])).toBe("FAILED");
    expect(status([attempt("passed", [], 1), attempt("passed", [ok], 2)])).toBe("NEEDS_REVIEW");
  });

  it("REQ-VER-02: a pass after an attempt that did not run is not PASSED (fail-closed)", () => {
    expect(status([attempt("error", [], 1), attempt("passed", [ok], 2)])).toBe("FAILED");
    expect(status([attempt("skipped", [], 1), attempt("passed", [ok], 2)])).toBe("FAILED");
  });

  it("REQ-EXEC-09/AC3: a pass that ran a healed spec is NEEDS_REVIEW, never PASSED or FLAKY", () => {
    expect(status([healed(attempt("passed", [ok]))])).toBe("NEEDS_REVIEW");
    expect(status([attempt("failed", [bad], 1), healed(attempt("passed", [ok], 2))])).toBe("NEEDS_REVIEW");
    expect(status([healed(attempt("failed", [bad], 1)), attempt("passed", [ok], 2)])).toBe("NEEDS_REVIEW");
  });

  it("REQ-EXEC-09/AC3: a healed spec that still fails stays FAILED; healed: false is not a heal", () => {
    expect(status([attempt("failed", [bad], 1), healed(attempt("failed", [bad], 2))])).toBe("FAILED");
    expect(status([healed(attempt("passed", [ok]), false)])).toBe("PASSED");
  });

  it("REQ-VER-02: a skipped first attempt does not make a later failure NOT_RUN", () => {
    expect(status([attempt("skipped", [], 1), attempt("failed", [bad], 2)])).toBe("FAILED");
  });

  it("REQ-VER-02/AC4: a skipped retry never hides an earlier failure; skipped after skipped is NOT_RUN", () => {
    expect(status([attempt("failed", [bad], 1), attempt("skipped", [], 2)])).toBe("FAILED");
    expect(status([attempt("failed", [ok], 1), attempt("skipped", [], 2)])).toBe("FAILED");
    expect(status([attempt("passed", [ok, bad], 1), attempt("skipped", [], 2)])).toBe("FAILED");
    expect(status([attempt("passed", [ok], 1), attempt("skipped", [], 2)])).toBe("NOT_RUN");
    expect(status([attempt("skipped", [], 1), attempt("skipped", [], 2)])).toBe("NOT_RUN");
  });
});
