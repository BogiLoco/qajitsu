// Adversarial suite: a lying author writes a spec whose assertions cannot fail, or can be skipped or swallowed, so a
// bug would not show as FAILED. The test code quality gate stops each one before it runs (REQ-VER-23/AC5).
// Scenario catalogue: .claude/skills/adversarial-test/scenarios.md
import { readFileSync } from "node:fs";
import { PlanSchema } from "@qajitsu/core";
import { blockingProblems, checkSpecSource } from "@qajitsu/verifier";
import { describe, expect, it } from "vitest";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-1",
  version: 1,
  ...(JSON.parse(
    readFileSync(new URL("../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8"),
  ) as object),
});
const honest = readFileSync(new URL("../../fixtures/specs/demo-1/TC-01.spec.ts", import.meta.url), "utf8");
const TOTAL = 'verify("S1", "fields.total", res.json("total"), plan.expect("TC-01.S1.fields.total"));';
const lie = (replace: string, by: string): string => {
  const spec = honest.replace(replace, by);
  expect(spec).not.toBe(honest);
  return spec;
};
const quality = (spec: string) =>
  blockingProblems(checkSpecSource(spec, "TC-01", plan)).filter((p) => p.check === "quality");

describe("the test code quality gate stops a lying author (REQ-VER-23)", () => {
  it("REQ-VER-23/AC5: the honest spec passes the gate", () => {
    expect(quality(honest)).toEqual([]);
  });

  it.each([
    ["AC1", "constant-actual", "passes the planned value as actual", lie('res.json("total")', "1.01")],
    [
      "AC1",
      "constant-actual",
      "passes plan.expect() as actual",
      lie('res.json("total")', 'plan.expect("TC-01.S1.fields.total")'),
    ],
    [
      "AC1",
      "constant-actual",
      "hides the constant in a variable",
      lie(TOTAL, `const total = 1.01;\n    ${TOTAL.replace('res.json("total")', "total")}`),
    ],
    [
      "AC1",
      "constant-actual",
      "compares a value with itself",
      lie('res.json("total")', 'res.json("total") === res.json("total")'),
    ],
    [
      "AC2",
      "skippable-verify",
      "checks the total only when it is right",
      lie(TOTAL, `if (res.json("total") === 1.01) ${TOTAL}`),
    ],
    [
      "AC2",
      "skippable-verify",
      "checks the total only on a 200",
      lie(TOTAL, `res.status === 200 && ${TOTAL}`),
    ],
    [
      "AC2",
      "skippable-verify",
      "checks inside a loop over the lines",
      lie(TOTAL, `for (const line of []) {\n      ${TOTAL}\n    }`),
    ],
    [
      "AC2",
      "skippable-verify",
      "checks in a callback that never runs",
      lie(TOTAL, `[].forEach(() => ${TOTAL.slice(0, -1)});`),
    ],
    [
      "AC2",
      "skippable-verify",
      "wraps the request and the check in try/catch",
      lie(
        'const res = await shopper.get("/cart");',
        'let res = await shopper.get("/cart");\n    try {\n      res = await shopper.get("/cart");',
      ).replace(TOTAL, `${TOTAL}\n    } catch (e) {\n      throw e;\n    }`),
    ],
    [
      "AC2",
      "swallowed-error",
      "swallows the error of adding the lines",
      lie(
        'await shopper.post("/cart/lines", { product_id: "P-1", quantity: 3 });',
        'await shopper.post("/cart/lines", { product_id: "P-1", quantity: 3 }).catch(() => undefined);',
      ),
    ],
    [
      "AC2",
      "swallowed-error",
      "has an empty catch",
      lie(
        'await shopper.post("/cart/lines", { product_id: "P-1", quantity: 3 });',
        'try {\n      await shopper.post("/cart/lines", { product_id: "P-1", quantity: 3 });\n    } catch {}',
      ),
    ],
    [
      "AC2",
      "early-return",
      "returns before the check when the total is wrong",
      lie(TOTAL, `if (res.json("total") !== 1.01) return;\n    ${TOTAL}`),
    ],
    [
      "AC2",
      "disabled-case",
      "marks the step as skipped",
      lie('await step("S1", async () => {', 'await step.skip("S1", async () => {'),
    ],
    [
      "AC3",
      "general-target",
      "checks the whole page",
      lie(
        TOTAL,
        'verify("S1", "elements.css:body.text", undefined, plan.expect("TC-01.S1.elements.css:body.text"));',
      ),
    ],
  ])("REQ-VER-23/%s: an author that %s… (%s)", (_ac, rule, _what, spec) => {
    const found = quality(spec);
    expect(found.map((p) => p.message.split(":")[0])).toContain(rule);
    // Every finding is blocking: the spec never runs.
    expect(found.every((p) => p.check === "quality")).toBe(true);
  });

  it("REQ-VER-23/AC3: a planned text so short it is found anywhere is a too general target", () => {
    const shortText = PlanSchema.parse({
      ...plan,
      cases: [
        {
          ...plan.cases[0],
          steps: [{ id: "S1", action: "GET /cart", expect: { description: "Shows 1", texts: ["1"] } }],
        },
      ],
    });
    const spec = honest
      .replace(/\s*verify\("S1", "status"[^\n]*\n/, "\n")
      .replace(TOTAL, 'verify("S1", "texts.0", undefined, plan.expect("TC-01.S1.texts.0"));');
    const found = checkSpecSource(spec, "TC-01", shortText).filter((p) => p.check === "quality");
    expect(found.map((p) => p.message)).toEqual([
      'general-target: verify("S1", "texts.0") looks for the text "1", which is found almost anywhere; the plan needs a more specific text or an element check',
    ]);
  });
});
