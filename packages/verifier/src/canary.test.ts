import { readFileSync } from "node:fs";
import { PlanSchema, type Plan } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { buildCanaryPlan, canaryCaught } from "./canary.js";

const fixture = (ticket: string): Plan =>
  PlanSchema.parse({
    schema: 1,
    ticket,
    version: 1,
    ...JSON.parse(
      readFileSync(
        new URL(`../../../fixtures/plans/${ticket.toLowerCase()}-draft.json`, import.meta.url),
        "utf8",
      ),
    ),
  });

const withExpect = (expect: Record<string, unknown>): Plan => {
  const plan = fixture("DEMO-1");
  const first = plan.cases[0]!;
  return {
    ...plan,
    cases: [
      {
        ...first,
        steps: [
          { id: "S1", action: "noop", expect: { description: "none" } },
          { id: "S2", action: "x", expect: { description: "d", ...expect } },
        ],
      },
    ],
  };
};

describe("canary (REQ-VER-09)", () => {
  it("REQ-VER-09/AC1: inverts exactly one expectation in a copy; the approved plan is unchanged", () => {
    const plan = fixture("DEMO-1");
    const before = JSON.stringify(plan);
    const canary = buildCanaryPlan(plan, plan.cases[0]!.id)!;
    expect(JSON.stringify(plan)).toBe(before);
    expect(canary.caseId).toBe(plan.cases[0]!.id);
    const changed = canary.plan.cases[0]!.steps.find((s) => s.id === canary.stepId)!.expect;
    const original = plan.cases[0]!.steps.find((s) => s.id === canary.stepId)!.expect;
    expect(changed).not.toEqual(original);
    expect(canary.plan.cases.slice(1)).toEqual(plan.cases.slice(1));
  });

  it("REQ-VER-09/AC1: inverts status, fields, texts and element states; skips steps without expectations", () => {
    expect(buildCanaryPlan(withExpect({ status: 418 }), "TC-01")).toMatchObject({
      stepId: "S2",
      field: "status",
    });
    expect(
      buildCanaryPlan(withExpect({ status: 418 }), "TC-01")?.plan.cases[0]?.steps[1]?.expect.status,
    ).toBe(419);
    const f = buildCanaryPlan(
      withExpect({ fields: { total: 95, code: "A", ok: true, nil: null } }),
      "TC-01",
    )!;
    expect(f.field).toBe("fields.total");
    expect(f.plan.cases[0]?.steps[1]?.expect.fields).toEqual({
      total: 1_000_098,
      code: "A",
      ok: true,
      nil: null,
    });
    for (const [value, inverted] of [
      ["A", "A ~qajitsu-canary~"],
      [true, false],
      [null, { __qajitsu_canary__: true }],
    ] as const)
      expect(
        buildCanaryPlan(withExpect({ fields: { v: value } }), "TC-01")?.plan.cases[0]?.steps[1]?.expect
          .fields,
      ).toEqual({ v: inverted });
    const t = buildCanaryPlan(withExpect({ texts: ["24,99 zł", "x"] }), "TC-01")!;
    expect([t.field, t.plan.cases[0]?.steps[1]?.expect.texts]).toEqual([
      "texts.0",
      ["24,99 zł ~qajitsu-canary~", "x"],
    ]);
    const el = buildCanaryPlan(withExpect({ elements: { "testid:pay": { enabled: true } } }), "TC-01")!;
    expect([el.field, el.plan.cases[0]?.steps[1]?.expect.elements]).toEqual([
      "elements.testid:pay.enabled",
      { "testid:pay": { enabled: false } },
    ]);
    expect(buildCanaryPlan(withExpect({}), "TC-01")).toBeUndefined();
    expect(buildCanaryPlan(fixture("DEMO-1"), "TC-99")).toBeUndefined();
  });

  it("REQ-VER-09/AC2: caught only when the inverted assertion was recorded and failed", () => {
    const canary = buildCanaryPlan(withExpect({ status: 200 }), "TC-01")!;
    const a = (pass: boolean, field = "status", stepId = "S2") => ({
      stepId,
      field,
      expected: 418,
      actual: 200,
      pass,
    });
    expect(canaryCaught(canary, [a(false)])).toBe(true);
    expect(canaryCaught(canary, [a(true)])).toBe(false);
    expect(canaryCaught(canary, [])).toBe(false);
    expect(canaryCaught(canary, [a(false, "fields.total"), a(false, "status", "S1")])).toBe(false);
  });
});
