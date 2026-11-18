import type { RunEvent } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { budgetLines } from "./budget-lines.js";
import { verdictTarget } from "./workflow.js";

const event = (details: Record<string, unknown>): RunEvent => ({
  ts: "2026-11-18T10:00:00.000Z",
  run: "r",
  ticket: "DEMO-1",
  stage: "author",
  actor: { kind: "system", name: "orchestrator" },
  event: "budget.exceeded",
  details,
});
const REASON = "ticket budget reached: $10.00 of $10.00 spent on this version of the ticket";

describe("budget section of a run (REQ-FLOW-06/AC8)", () => {
  it("REQ-FLOW-06/AC8: names the stop and only the cases it left untested; finished results stay counted", () => {
    expect(
      budgetLines(
        [event({ scope: "ticket", metric: "cost", limit: 10, spent: 10, reason: REASON })],
        [
          { caseId: "TC-01", status: "PASSED" },
          { caseId: "TC-02", status: "NOT_RUN", reason: REASON },
          { caseId: "TC-03", status: "NOT_RUN", reason: "not selected (--cases)" },
          { caseId: "TC-04", status: "FAILED", reason: "expected 200, got 500" },
        ],
      ),
    ).toEqual([
      `Work stopped: ${REASON}.`,
      "Not tested because of it: TC-02 NOT_RUN.",
      "The other 3 of 4 case(s) have their computed results above.",
    ]);
  });

  it("REQ-FLOW-06/AC8: the run's own token budget and runs without a stop give no section", () => {
    expect(
      budgetLines([event({ budget: 1000, total: 1200 })], [{ caseId: "TC-01", status: "PASSED" }]),
    ).toEqual([]);
    expect(budgetLines([], [{ caseId: "TC-01", status: "NOT_RUN", reason: REASON }])).toEqual([]);
  });

  it("REQ-FLOW-06/AC8 + INV-1: a budget stop sends the ticket to needs_review, never to passed; a FAILED case still goes back", () => {
    expect(verdictTarget(["PASSED", "NOT_RUN"], false, true).role).toBe("needs_review");
    expect(verdictTarget(["PASSED"], true, true).role).toBe("needs_review");
    expect(verdictTarget(["PASSED", "FAILED"], false, true).role).toBe("failed");
    expect(verdictTarget(["PASSED"], false, false).role).toBe("passed");
  });
});
