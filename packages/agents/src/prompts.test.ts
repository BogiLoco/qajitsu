import { ExpectationSchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { PLANNER_SYSTEM } from "./prompts.js";

/** Every `"key": {...}` example of the planner prompt for one expectation kind, as JSON. */
const example = (key: string): unknown => {
  const at = PLANNER_SYSTEM.indexOf(`"${key}": {`);
  expect(at).toBeGreaterThanOrEqual(0);
  let depth = 0;
  const start = PLANNER_SYSTEM.indexOf("{", at);
  for (let i = start; i < PLANNER_SYSTEM.length; i++) {
    if (PLANNER_SYSTEM[i] === "{") depth += 1;
    if (PLANNER_SYSTEM[i] === "}") depth -= 1;
    if (depth === 0) return JSON.parse(PLANNER_SYSTEM.slice(start, i + 1).replace(/\s+/g, " "));
  }
  throw new Error(`no example for ${key}`);
};

describe("planner prompt (REQ-PLAN-02, REQ-EXEC-05)", () => {
  it("REQ-EXEC-05/AC1: the element and visual examples the planner is shown are valid expectations", () => {
    expect(ExpectationSchema.safeParse({ description: "d", elements: example("elements") }).success).toBe(
      true,
    );
    expect(ExpectationSchema.safeParse({ description: "d", visual: example("visual") }).success).toBe(true);
    expect(PLANNER_SYSTEM).toContain("testid:<test id>");
    expect(PLANNER_SYSTEM).toContain('lower-case letters, digits and "-" only');
  });
});
