import type { AssertionRecord, Plan } from "@qajitsu/core";

/** A copy of the plan with exactly one expectation inverted (REQ-VER-09/AC1). */
export interface CanaryPlan {
  readonly plan: Plan;
  readonly caseId: string;
  readonly stepId: string;
  /** Assertion field as recorded by the runner, e.g. `status`, `fields.total`, `texts.0`. */
  readonly field: string;
}

const invert = (value: unknown): unknown => {
  if (typeof value === "number") return value + 1_000_003;
  if (typeof value === "string") return `${value} ~qajitsu-canary~`;
  if (typeof value === "boolean") return !value;
  return { __qajitsu_canary__: true };
};

/**
 * Builds the canary of a case: the first expectation of its first step that has one (status, then a
 * field, a text or an element property) is replaced by a value the application cannot produce.
 * The original plan is not changed; the approved file stays frozen (invariant 3).
 *
 * @param plan - Approved plan.
 * @param caseId - Case to use, normally one that PASSED.
 * @returns The canary plan, or undefined when the case has no structured expectation.
 */
export function buildCanaryPlan(plan: Plan, caseId: string): CanaryPlan | undefined {
  const index = plan.cases.findIndex((c) => c.id === caseId);
  const testCase = plan.cases[index];
  if (!testCase) return undefined;
  for (const [stepIndex, step] of testCase.steps.entries()) {
    const e = step.expect;
    let field: string | undefined;
    let expect = e;
    if (e.status !== undefined) {
      field = "status";
      expect = { ...e, status: e.status === 418 ? 419 : 418 };
    } else if (e.fields && Object.keys(e.fields).length > 0) {
      const [path, value] = Object.entries(e.fields)[0] ?? ["", undefined];
      field = `fields.${path}`;
      expect = { ...e, fields: { ...e.fields, [path]: invert(value) } };
    } else if (e.texts && e.texts.length > 0) {
      field = "texts.0";
      expect = { ...e, texts: [String(invert(e.texts[0])), ...e.texts.slice(1)] };
    } else if (e.elements && Object.keys(e.elements).length > 0) {
      const [selector, state] = Object.entries(e.elements)[0] ?? ["", {}];
      const [prop, value] = Object.entries(state)[0] ?? ["visible", true];
      field = `elements.${selector}.${prop}`;
      expect = { ...e, elements: { ...e.elements, [selector]: { ...state, [prop]: invert(value) } } };
    }
    if (field === undefined) continue;
    const steps = testCase.steps.map((s, i) => (i === stepIndex ? { ...s, expect } : s));
    const cases = plan.cases.map((c, i) => (i === index ? { ...c, steps } : c));
    return { plan: { ...plan, cases }, caseId, stepId: step.id, field };
  }
  return undefined;
}

/**
 * Whether the runner caught the canary: the inverted assertion must be recorded and must have failed.
 * An attempt that never evaluated it is not caught, so a test that cannot fail is never trusted.
 *
 * @param canary - The canary plan.
 * @param assertions - Assertions of the canary attempt.
 */
export function canaryCaught(canary: CanaryPlan, assertions: readonly AssertionRecord[]): boolean {
  return assertions.some((a) => a.stepId === canary.stepId && a.field === canary.field && !a.pass);
}
