import { describe, expect, it } from "vitest";
import { applyDepth } from "./depth.js";
import { PlanDraftSchema, PlanSchema } from "./schemas.js";
import { renderPlanMarkdown } from "./plan-store.js";

const testCase = (id: string, priority: "high" | "medium" | "low") => ({
  id,
  title: `Case ${id}`,
  type: "api",
  priority,
  source: [{ kind: "ac", id: "AC1" }],
  steps: [{ id: "S1", action: "GET /cart", expect: { description: "ok", status: 200 } }],
  evidence: ["response"],
});
const draft = PlanDraftSchema.parse({
  summary: "s",
  cases: [testCase("TC-01", "high"), testCase("TC-02", "medium"), testCase("TC-03", "low")],
  out_of_scope: ["Fixed-amount codes"],
});

describe("test depth (REQ-PLAN-08/AC1)", () => {
  it("REQ-PLAN-08/AC1: smoke keeps high, standard high and medium, full everything; each case says why", () => {
    expect(applyDepth(draft, "smoke").cases.map((c) => c.id)).toEqual(["TC-01"]);
    expect(applyDepth(draft, "standard").cases.map((c) => c.id)).toEqual(["TC-01", "TC-02"]);
    expect(applyDepth(draft, "full").cases.map((c) => c.id)).toEqual(["TC-01", "TC-02", "TC-03"]);
    const smoke = applyDepth(draft, "smoke");
    expect(smoke.depth).toBe("smoke");
    expect(smoke.selection).toEqual([
      {
        case: "TC-01",
        title: "Case TC-01",
        priority: "high",
        included: true,
        reason: "priority high is part of depth smoke",
      },
      {
        case: "TC-02",
        title: "Case TC-02",
        priority: "medium",
        included: false,
        reason: "priority medium is below depth smoke",
      },
      {
        case: "TC-03",
        title: "Case TC-03",
        priority: "low",
        included: false,
        reason: "priority low is below depth smoke",
      },
    ]);
    expect(smoke.out_of_scope).toEqual([
      "Fixed-amount codes",
      "TC-02 Case TC-02 (priority medium is below depth smoke)",
      "TC-03 Case TC-03 (priority low is below depth smoke)",
    ]);
  });

  it("REQ-PLAN-08/AC1: when no case reaches the depth the highest priority present is kept, never an empty plan", () => {
    const lows = PlanDraftSchema.parse({ cases: [testCase("TC-01", "low"), testCase("TC-02", "medium")] });
    const smoke = applyDepth(lows, "smoke");
    expect(smoke.cases.map((c) => c.id)).toEqual(["TC-02"]);
    expect(smoke.selection.find((x) => x.case === "TC-02")?.reason).toContain(
      "the highest priority present (medium) is kept",
    );
  });

  it("REQ-PLAN-08/AC1: plan.md shows the depth and the selection", () => {
    const plan = PlanSchema.parse({
      schema: 1,
      ticket: "DEMO-1",
      version: 1,
      ...applyDepth(draft, "standard"),
    });
    const md = renderPlanMarkdown(plan);
    expect(md).toContain("Depth: **standard**");
    expect(md).toContain("## Selection");
    expect(md).toContain("- out: TC-03 Case TC-03 (priority low is below depth standard)");
  });
});
