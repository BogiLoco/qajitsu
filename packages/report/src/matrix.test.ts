import { describe, expect, it } from "vitest";
import { countStatuses, renderMatrixMarkdown, summaryLine, type MatrixRow } from "./matrix.js";

const row = (caseId: string, status: MatrixRow["status"], extra: Partial<MatrixRow> = {}): MatrixRow => ({
  caseId,
  title: `Case ${caseId}`,
  requirement: "AC-1",
  type: "api",
  status,
  stepsPassed: 1,
  stepsTotal: 1,
  evidence: "req/resp",
  ...extra,
});

describe("countStatuses (REQ-VER-08)", () => {
  it("counts every status including zeros", () => {
    const counts = countStatuses([row("TC-01", "PASSED"), row("TC-02", "PASSED"), row("TC-03", "FAILED")]);
    expect(counts).toEqual({ PASSED: 2, FAILED: 1, FLAKY: 0, BLOCKED: 0, NOT_RUN: 0, NEEDS_REVIEW: 0 });
  });
});

describe("summaryLine", () => {
  it("lists non-zero statuses in canonical order", () => {
    expect(summaryLine([row("TC-02", "BLOCKED"), row("TC-01", "PASSED")])).toBe(
      "2 cases: 1 PASSED, 1 BLOCKED",
    );
  });
  it("uses the singular for one case", () => {
    expect(summaryLine([row("TC-01", "FAILED")])).toBe("1 case: 1 FAILED");
  });
  it("handles an empty run", () => {
    expect(summaryLine([])).toBe("0 cases");
  });
});

describe("renderMatrixMarkdown (REQ-EVD-04)", () => {
  it("escapes pipes and newlines in cells", () => {
    const md = renderMatrixMarkdown([row("TC-01", "PASSED", { title: "a | b\nc" })]);
    expect(md).toContain("a \\| b c");
  });
  it("renders only the header for an empty run", () => {
    expect(renderMatrixMarkdown([])).toBe(
      "**0 cases**\n\n| TC | Title | Requirement | Type | Status | Steps OK | Evidence |\n| --- | --- | --- | --- | --- | --- | --- |\n",
    );
  });
});
