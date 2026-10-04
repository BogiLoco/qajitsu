import { TEST_STATUSES, type AuditRecord, type CanaryRecord } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { applyVerificationChecks } from "./checks.js";

const all = TEST_STATUSES.map((status, i) => ({ caseId: `TC-0${String(i + 1)}`, status }));
const done = (
  findings: AuditRecord extends infer R ? (R extends { findings: infer F } ? F : never) : never,
): AuditRecord => ({
  schema: 1,
  status: "done",
  mode: "optional",
  model: "m/a",
  sameModelAsAuthor: false,
  findings,
});
const canary = (caught: boolean, status: CanaryRecord["status"] = "ran"): CanaryRecord => ({
  schema: 1,
  status,
  caseId: "TC-01",
  stepId: "S1",
  field: "status",
  caught,
  detail: "",
});

describe("auditor and canary checks (REQ-VER-06, REQ-VER-09, invariant 5)", () => {
  it("REQ-VER-06/AC2: a weak finding moves PASSED to NEEDS_REVIEW and nothing else", () => {
    const weakForAll = done(
      all.map((c) => ({ caseId: c.caseId, weak: true, reason: "evidence shows an error" })),
    );
    const checked = applyVerificationChecks(all, weakForAll);
    for (const [i, c] of checked.entries()) {
      const before = all[i]?.status;
      expect(c.status).toBe(before === "PASSED" ? "NEEDS_REVIEW" : before);
      expect(c.downgradedBy !== undefined).toBe(before === "PASSED");
    }
    expect(checked.find((c) => c.downgradedBy)?.downgradedBy).toBe("auditor: evidence shows an error");
    const notWeak = done([{ caseId: "TC-01", weak: false, reason: "fine" }]);
    expect(applyVerificationChecks([{ caseId: "TC-01", status: "PASSED" }], notWeak)).toEqual([
      { caseId: "TC-01", status: "PASSED" },
    ]);
  });

  it("REQ-VER-06: a failed audit downgrades only in required mode", () => {
    const failed = (mode: "optional" | "required"): AuditRecord => ({
      schema: 1,
      status: "failed",
      mode,
      error: "no vision model",
    });
    const passed = [{ caseId: "TC-01", status: "PASSED" as const }];
    expect(applyVerificationChecks(passed, failed("optional"))[0]?.status).toBe("PASSED");
    expect(applyVerificationChecks(passed, failed("required"))[0]).toEqual({
      caseId: "TC-01",
      status: "NEEDS_REVIEW",
      downgradedBy: "required audit failed: no vision model",
    });
  });

  it("REQ-VER-09/AC2: a canary that passes makes every PASSED NEEDS_REVIEW; a caught canary changes nothing", () => {
    expect(applyVerificationChecks(all, undefined, canary(true)).map((c) => c.status)).toEqual([
      ...TEST_STATUSES,
    ]);
    const loose = applyVerificationChecks(all, undefined, canary(false));
    expect(loose.map((c) => c.status)).toEqual(
      TEST_STATUSES.map((s) => (s === "PASSED" ? "NEEDS_REVIEW" : s)),
    );
    expect(loose.find((c) => c.downgradedBy)?.downgradedBy).toContain("canary not caught");
    // A canary that could not run is not caught; a skipped one (nothing to invert) changes nothing.
    expect(
      applyVerificationChecks(all, undefined, { ...canary(false, "error"), detail: "spawn failed" }).find(
        (c) => c.downgradedBy,
      )?.downgradedBy,
    ).toBe("canary could not run: spawn failed");
    expect(applyVerificationChecks(all, undefined, canary(false, "skipped")).map((c) => c.status)).toEqual([
      ...TEST_STATUSES,
    ]);
  });

  it("REQ-VER-06 + REQ-VER-09: missing or changed records fail closed", () => {
    const checked = applyVerificationChecks(all, undefined, undefined, ["checks/audit.json is missing"]);
    expect(checked.map((c) => c.status)).toEqual(
      TEST_STATUSES.map((s) => (s === "PASSED" ? "NEEDS_REVIEW" : s)),
    );
    expect(checked.find((c) => c.downgradedBy)?.downgradedBy).toBe(
      "verification records not trustworthy: checks/audit.json is missing",
    );
  });
});
