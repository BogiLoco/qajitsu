import { describe, expect, it } from "vitest";
import { combineStatuses } from "./matrix.js";

describe("browser and viewport matrix (REQ-EXEC-13)", () => {
  it("REQ-EXEC-13/AC2: a case is PASSED only when every combination passed", () => {
    expect(combineStatuses(["PASSED", "PASSED", "PASSED"])).toBe("PASSED");
    expect(combineStatuses(["PASSED", "NEEDS_REVIEW"])).toBe("NEEDS_REVIEW");
    expect(combineStatuses(["PASSED", "NOT_RUN"])).toBe("NOT_RUN");
  });

  it("REQ-EXEC-13/AC2+AC3: the worst combination decides: an observed failure first, then flaky, blocked, review", () => {
    expect(combineStatuses(["PASSED", "BLOCKED", "FAILED"])).toBe("FAILED");
    expect(combineStatuses(["FLAKY", "BLOCKED"])).toBe("FLAKY");
    expect(combineStatuses(["PASSED", "BLOCKED"])).toBe("BLOCKED");
    expect(combineStatuses(["NEEDS_REVIEW", "BLOCKED"])).toBe("BLOCKED");
    expect(combineStatuses(["NOT_RUN", "NEEDS_REVIEW"])).toBe("NEEDS_REVIEW");
  });

  it("REQ-EXEC-13/AC2: no combination at all is NOT_RUN, never PASSED", () => {
    expect(combineStatuses([])).toBe("NOT_RUN");
  });
});
