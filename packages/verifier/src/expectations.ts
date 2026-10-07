import type { Expectation } from "@qajitsu/core";

/**
 * Assertion fields a step's structured expectation asks for, named as the runner records them:
 * `status`, `fields.<path>`, `texts.<i>`, `elements.<selector>.<property>`. A case can only be PASSED
 * when each of them was verified; a spec that leaves one out would pass whatever that value is.
 *
 * @param expect - The step's expectation from the approved plan.
 */
export function plannedFields(expect: Expectation): string[] {
  return [
    ...(expect.status === undefined ? [] : ["status"]),
    ...Object.keys(expect.fields ?? {}).map((path) => `fields.${path}`),
    ...(expect.texts ?? []).map((_, i) => `texts.${String(i)}`),
    ...Object.entries(expect.elements ?? {}).flatMap(([selector, state]) =>
      Object.keys(state).map((prop) => `elements.${selector}.${prop}`),
    ),
    ...(expect.message === undefined ? [] : ["message"]),
    ...(expect.visual === undefined ? [] : ["visual"]),
  ];
}
