import type { Expectation } from "@qajitsu/core";

/**
 * Assertion fields a step's structured expectation asks for, named as the runner records them:
 * `status`, `fields.<path>`, `texts.<i>`, `elements.<selector>.<property>`, `download.*`, `state.<path>`, `manifest.<field>`. A case can only be PASSED
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
    ...downloadFields(expect.download),
    ...(expect.dialog?.type === undefined ? [] : ["dialog.type"]),
    ...(expect.dialog?.message === undefined ? [] : ["dialog.message"]),
    ...Object.keys(expect.state ?? {}).map((path) => `state.${path}`),
    ...Object.entries(expect.manifest ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([part]) => `manifest.${part}`),
    ...(expect.message === undefined ? [] : ["message"]),
    ...(expect.visual === undefined ? [] : ["visual"]),
  ];
}

/** The `download.*` fields a planned download asks for (REQ-EXEC-38/AC2). */
function downloadFields(d: Expectation["download"]): string[] {
  if (d === undefined) return [];
  return [
    ...(d.name === undefined ? [] : ["download.name"]),
    ...(d.type === undefined ? [] : ["download.type"]),
    ...(d.min_bytes === undefined && d.max_bytes === undefined ? [] : ["download.size"]),
    ...(d.sha256 === undefined ? [] : ["download.sha256"]),
    ...(d.rows === undefined ? [] : ["download.rows"]),
    ...(d.count === undefined ? [] : ["download.count"]),
    ...(d.texts ?? []).map((_, i) => `download.texts.${String(i)}`),
    ...Object.keys(d.fields ?? {}).map((path) => `download.fields.${path}`),
  ];
}
