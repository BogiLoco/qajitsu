import { readFileSync } from "node:fs";
import { PlanSchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { checkSpecQuality } from "./spec-quality.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-1",
  version: 1,
  ...(JSON.parse(
    readFileSync(new URL("../../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8"),
  ) as object),
});

/** A spec whose step S1 has the given body. */
const spec = (body: string, outside = ""): string =>
  `import type { CaseContext } from "@qajitsu/steps";\nexport const caseId = "TC-01";\nexport async function run({ step, verify, plan, api }: CaseContext): Promise<void> {\n  const res = await api.get("/cart");\n${outside}  await step("S1", async () => {\n${body}\n  });\n}\n`;
const V = (actual = 'res.json("total")') =>
  `verify("S1", "fields.total", ${actual}, plan.expect("TC-01.S1.fields.total"));`;
const rules = (source: string) => checkSpecQuality(source, "TC-01", plan).map((f) => f.rule);

describe("test code quality gate (REQ-VER-23)", () => {
  it("REQ-VER-23/AC1: constants of every shape are not values from the application; reading the response is", () => {
    for (const actual of [
      "`1.01`",
      "-1",
      "[1, 2]",
      "{ total: 1.01 }",
      "null",
      "true",
      "false",
      "NaN",
      "(1.01 as number)",
      "1 === 1",
    ])
      expect(rules(spec(V(actual))), actual).toEqual(["constant-actual"]);
    for (const actual of [
      'res.json("total")',
      "undefined",
      "res.status === 200",
      "{ total: res.json('total') }",
    ])
      expect(rules(spec(V(actual))), actual).toEqual([]);
    // A let can change; only const values are followed.
    expect(rules(spec(`let t = 1;\n${V("t")}`))).toEqual([]);
  });

  it("REQ-VER-23/AC2: every way to skip a verify() is named", () => {
    expect(rules(spec(`const ok = res.status === 200 ? ${V().slice(0, -1)} : undefined;`))).toEqual([
      "skippable-verify",
    ]);
    expect(rules(spec(`switch (res.status) {\n case 200:\n ${V()}\n }`))).toEqual(["skippable-verify"]);
    expect(rules(spec(`try {\n await api.get("/x");\n } catch (e) {\n ${V()}\n }`))).toEqual([
      "skippable-verify",
    ]);
    expect(rules(spec(`let i = 0;\nwhile (i++ < 1) { ${V()} }`))).toEqual(["skippable-verify"]);
    expect(rules(spec(`res.maybe?.(${V().slice(0, -1)});`))).toEqual(["skippable-verify"]);
    expect(rules(spec(`setTimeout(function () { ${V()} });`))).toEqual(["skippable-verify"]);
    expect(rules(spec(`res.status ?? ${V()}`))).toEqual(["skippable-verify"]);
    // The condition of an if is evaluated anyway; a verify() there is not skipped.
    expect(rules(spec(`if (${V().slice(0, -1)}) {}`))).toEqual([]);
    // try/finally rethrows: nothing is swallowed or skipped silently.
    expect(
      rules(spec(`try {\n await api.get("/x");\n } finally {\n await api.get("/y");\n }\n${V()}`)),
    ).toEqual([]);
  });

  it("REQ-VER-23/AC2: an early return, a return after the checks, empty handlers and disabled cases", () => {
    expect(rules(spec(`if (res.status !== 200) return;\n${V()}\n${V()}`))).toEqual(["early-return"]);
    expect(rules(spec(`${V()}\nreturn;`))).toEqual([]);
    expect(rules(spec(V(), "  if (res.status !== 200) return;\n"))).toEqual(["early-return"]);
    expect(rules(spec(`await api.get("/x").catch(() => {});\n${V()}`))).toEqual(["swallowed-error"]);
    expect(rules(spec(`await api.get("/x").catch(() => null);\n${V()}`))).toEqual(["swallowed-error"]);
    expect(rules(spec(`const noop = () => undefined;\nawait api.get("/x").catch(noop);\n${V()}`))).toEqual([
      "swallowed-error",
    ]);
    expect(rules(spec(`await api.get("/x").catch(function () {});\n${V()}`))).toEqual(["swallowed-error"]);
    // A handler that does something is not empty.
    expect(rules(spec(`await api.get("/x").catch((e: unknown) => { throw e; });\n${V()}`))).toEqual([]);
    expect(rules(`xit("x", () => {});\n${spec(V())}`)).toEqual(["disabled-case"]);
    const narrowed = ["describe", "only"].join(".");
    expect(rules(`${narrowed}("x", () => {});\n${spec(V())}`)).toEqual(["disabled-case"]);
  });

  it("REQ-VER-23/AC3: page-level selectors are too general; a named element is not", () => {
    for (const selector of ["css:html", "xpath://body", "role:main", "css::root"])
      expect(
        rules(spec(`verify("S1", "elements.${selector}.text", undefined, plan.expect("x"));`)),
        selector,
      ).toEqual(["general-target"]);
    expect(rules(spec(`verify("S1", "elements.testid:total.text", undefined, plan.expect("x"));`))).toEqual(
      [],
    );
    // A verify() without literal ids is reported by the static checks; the gate only names what it can read.
    expect(rules(spec(`verify(id, field, res.json("total"), plan.expect("x"));`))).toEqual([]);
    // Texts of a case or step the plan does not have are left to the coverage check.
    expect(
      checkSpecQuality(spec(`verify("S9", "texts.0", undefined, plan.expect("x"));`), "TC-09", plan),
    ).toEqual([]);
  });
});
