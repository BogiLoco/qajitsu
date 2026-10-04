import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanSchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import {
  assertionLockDiff,
  blockingProblems,
  checkSpecSource,
  formatSpecProblems,
  stepsTypesEntry,
  typecheckSpecs,
} from "./spec-checks.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-1",
  version: 1,
  ...JSON.parse(readFileSync(new URL("../../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8")),
});
const good = readFileSync(new URL("../../../fixtures/specs/demo-1/TC-02.spec.ts", import.meta.url), "utf8");
const messages = (src: string, id = "TC-02") =>
  checkSpecSource(src, id, plan).map((p) => `${p.check}: ${p.message}`);

describe("static checks of generated specs (REQ-EXEC-03)", () => {
  it("accepts a spec that covers every step and reads expectations from the plan", () => {
    expect(checkSpecSource(good, "TC-02", plan)).toEqual([]);
  });

  it("REQ-EXEC-03/AC3: rejects literal expected values (assertion lock)", () => {
    const literal = good.replace('plan.expect("TC-02.S1.status")', "200");
    expect(messages(literal)).toContain(
      'assertion-lock: verify("S1", "status", ...) must use plan.expect("TC-02.S1.status") as the expected value',
    );
  });

  it.each([
    ["another case's expectation", 'plan.expect("TC-01.S1.status")'],
    ["another step's expectation", 'plan.expect("TC-02.S2.status")'],
    ["a computed path", 'plan.expect("TC-02.S1." + "status")'],
    ["the actual value", "res.status"],
  ])("REQ-EXEC-03/AC3: rejects %s as expected value", (_, replacement) => {
    expect(
      messages(good.replace('plan.expect("TC-02.S1.status")', replacement)).some((m) =>
        m.startsWith("assertion-lock"),
      ),
    ).toBe(true);
  });

  it("REQ-EXEC-03/AC2: every plan step needs one step() and at least one verify()", () => {
    const noS2 = good.slice(0, good.indexOf('  await step("S2"')) + "}\n";
    expect(messages(noS2)).toEqual([
      'coverage: plan step S2 has no step("S2") call',
      'coverage: plan step S2 has no verify("S2", ...) call',
    ]);
    const noVerify = good.replace(/verify\(\s*"S2"[\s\S]*?\);\n/g, "");
    expect(messages(noVerify)).toEqual(['coverage: plan step S2 has no verify("S2", ...) call']);
    expect(messages(good.replace('step("S2"', 'step("S9"'))).toContain(
      'coverage: step("S9") is not a step of TC-02',
    );
    expect(messages(good.replace('step("S2"', 'step("S1"'))).toContain(
      'coverage: step("S1") appears 2 times',
    );
    expect(messages(good.replace('step("S1"', "step(id"))).toContain(
      "coverage: step() needs a literal step id",
    );
    expect(
      messages(
        good.replace(
          'verify("S1", "status", res.status, plan.expect("TC-02.S1.status"))',
          'verify("S1", res.status)',
        ),
      ),
    ).toContain(
      "assertion-lock: verify(stepId, field, actual, expected) needs literal step id and field and exactly 4 arguments",
    );
  });

  it.each([
    ['import { readFileSync } from "node:fs";', "only 'import type"],
    ['import { createCaseRuntime } from "@qajitsu/steps";', "only 'import type"],
    ["const env = process.env;", "'process' is not allowed"],
    ['const x = await import("node:fs");', "dynamic import() is not allowed"],
    ['await fetch("https://attacker.example.org");', "'fetch' is not allowed"],
    ['eval("1");', "'eval' is not allowed"],
    ["const g = globalThis;", "'globalThis' is not allowed"],
    ['const f = new Function("return 1");', "'Function' is not allowed"],
    ["export default {};", "default exports are not allowed"],
    ['const p = api.get.constructor("return process")();', "'.constructor' is not allowed"],
    ['const p = ({})["constructor"];', "'[\"constructor\"]' is not allowed"],
    ["Array.prototype.push = () => 0;", "'.prototype' is not allowed"],
    ['const k = "push"; const x = [][k];', "computed member access is not allowed"],
    ["const f = verify.bind(null);", "'.bind' is not allowed"],
  ])("REQ-EXEC-03/AC1 lint: rejects %s", (code, expected) => {
    const src = code.startsWith("import")
      ? `${code}\n${good}`
      : good.replace("export async function run", `${code}\nexport async function run`);
    expect(messages(src).join("\n")).toContain(expected);
  });

  it("REQ-LLM-05/AC2: every planned expectation needs its own verify(); leaving one out is blocked", () => {
    const tc1 = readFileSync(
      new URL("../../../fixtures/specs/demo-1/TC-01.spec.ts", import.meta.url),
      "utf8",
    );
    expect(checkSpecSource(tc1, "TC-01", plan)).toEqual([]);
    const lazy = tc1.replace(/\s*verify\("S1", "fields\.total"[^\n]*\n/, "\n");
    expect(checkSpecSource(lazy, "TC-01", plan).map((p) => [p.check, p.message])).toEqual([
      ["coverage", 'expectation S1 fields.total has no verify("S1", "fields.total", ...) call'],
    ]);
  });

  it("requires the caseId and run exports", () => {
    expect(messages(good.replace('"TC-02";', '"TC-01";'))).toContain(
      'lint: export const caseId must be "TC-02"',
    );
    expect(messages(good.replace("export async function run", "async function run"))).toContain(
      "lint: missing 'export async function run(context)'",
    );
    expect(messages("export {};", "TC-02")).toContain("lint: missing 'export const caseId = \"TC-02\"'");
    expect(checkSpecSource(good, "TC-99", plan)).toEqual([
      { check: "coverage", message: "TC-99 is not in the approved plan" },
    ]);
  });

  it("allows object keys and property names that look like forbidden globals", () => {
    const src = good
      .replace('{ code: "SAVE10" }', '{ code: "SAVE10", process: 1 }')
      .replace("res.status, plan", "res.headers.fetch ?? res.status, plan");
    expect(checkSpecSource(src, "TC-02", plan)).toEqual([]);
  });

  it("REQ-EXEC-03/AC1: type-checks specs against the @qajitsu/steps API", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qj-tsc-"));
    try {
      const ok = join(dir, "TC-02.spec.ts");
      const bad = join(dir, "TC-01.spec.ts");
      await writeFile(ok, good);
      await writeFile(bad, good.replace("api.as", "api.ass").replace('"TC-02"', '"TC-01"'));
      const result = typecheckSpecs([ok, bad]);
      expect(result.get(ok)).toEqual([]);
      expect(formatSpecProblems(result.get(bad) ?? [])).toMatch(
        /typecheck \(line \d+\): Property 'ass' does not exist/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("allows literal member access and non-caseId exports; resolves the steps types", () => {
    const src = good
      .replace("res.status, plan", 'res["status"], plan')
      .replace("export async function run", "export const note = 1;\nexport async function run");
    expect(checkSpecSource(src, "TC-02", plan)).toEqual([]);
    expect(stepsTypesEntry(() => true)).toMatch(/steps\/dist\/index\.d\.ts$/);
    expect(stepsTypesEntry(() => false)).toMatch(/steps\/src\/index\.ts$/);
    expect(formatSpecProblems([{ check: "lint", message: "m" }])).toBe("lint: m");
  });

  it("REQ-EXEC-05/AC2: CSS selectors are flagged for review but do not block", () => {
    const web = readFileSync(
      new URL("../../../fixtures/specs/demo-4/TC-01.spec.ts", import.meta.url),
      "utf8",
    ).replace('"testid:accept-terms"', '"css:#terms"');
    const webPlan = PlanSchema.parse({
      schema: 1,
      ticket: "DEMO-4",
      version: 1,
      ...JSON.parse(
        readFileSync(new URL("../../../fixtures/plans/demo-4-draft.json", import.meta.url), "utf8"),
      ),
    });
    const problems = checkSpecSource(web, "TC-01", webPlan);
    expect(problems.map((p) => p.check)).toEqual(["review"]);
    expect(blockingProblems(problems)).toEqual([]);
  });
});

describe("assertion lock for the healer (REQ-EXEC-09/AC2)", () => {
  const original = readFileSync(
    new URL("../../../fixtures/specs/demo-5/TC-01.spec.ts", import.meta.url),
    "utf8",
  );
  it("allows changed selectors and waits", () => {
    const healed = original
      .replace('"testid:place-order"', '"role:button:Place order"')
      .replace(
        'await ui.waitFor("testid:toast");',
        'await ui.waitFor("testid:toast");\n    await ui.waitFor("role:status");',
      );
    expect(assertionLockDiff(original, healed)).toEqual([]);
  });
  it.each([
    [
      "a removed verify",
      (s: string) => s.replace(/verify\(\s*"S3",\s*"fields\.lines\.length"[\s\S]*?\);\n/, ""),
    ],
    [
      "a changed expectation key",
      (s: string) => s.replace('plan.expect("TC-01.S3.status")', 'plan.expect("TC-01.S1.status")'),
    ],
    ["a literal expected value", (s: string) => s.replace('plan.expect("TC-01.S3.status")', "200")],
    ["a renamed step", (s: string) => s.replace('step("S2"', 'step("S9"')],
    [
      "an added try/catch",
      (s: string) =>
        s.replace(
          'await ui.click("testid:place-order");',
          'try { await ui.click("testid:place-order"); } catch {}',
        ),
    ],
  ])("rejects %s", (_, mutate) => {
    expect(assertionLockDiff(original, mutate(original)).length).toBeGreaterThan(0);
  });
});
