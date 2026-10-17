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
  stepsWithoutActions,
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

  it("REQ-EXEC-03/AC2: verify() runs inside the function of its own step", () => {
    const tc1 = readFileSync(
      new URL("../../../fixtures/specs/demo-1/TC-01.spec.ts", import.meta.url),
      "utf8",
    );
    expect(checkSpecSource(tc1, "TC-01", plan)).toEqual([]);
    // Moved after the step: the runtime would throw; the static check says so before anything runs.
    const outside = good.replace(
      /\n\}\s*$/,
      '\n  verify("S2", "status", 1, plan.expect("TC-02.S2.status"));\n}\n',
    );
    expect(messages(outside)).toContain(
      'coverage: verify("S2", ...) must be inside step("S2", ...); it is outside every step',
    );
    // Inside another step's function: attributed to the wrong step.
    const wrongStep = good.replace(
      'verify("S1", "status", res.status, plan.expect("TC-02.S1.status"))',
      'verify("S1", "status", res.status, plan.expect("TC-02.S1.status"));\n    verify("S2", "status", res.status, plan.expect("TC-02.S2.status"))',
    );
    expect(messages(wrongStep)).toContain(
      'coverage: verify("S2", ...) must be inside step("S2", ...); it is inside step("S1", ...)',
    );
    // A helper function declared inside the step still counts as inside it.
    const helper = good.replace(
      'verify("S1", "status", res.status, plan.expect("TC-02.S1.status"))',
      'const check = () => verify("S1", "status", res.status, plan.expect("TC-02.S1.status"));\n    check()',
    );
    expect(messages(helper).filter((m) => m.includes("must be inside"))).toEqual([]);
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

  it("REQ-EXEC-03/AC1: a spec is always checked as it is now, never from an earlier check of the same path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qj-tsc-"));
    try {
      const file = join(dir, "TC-02.spec.ts");
      await writeFile(file, good);
      expect(typecheckSpecs([file]).get(file)).toEqual([]);
      await writeFile(file, good.replace("api.as", "api.ass"));
      expect(formatSpecProblems(typecheckSpecs([file]).get(file) ?? [])).toMatch(
        /Property 'ass' does not exist/,
      );
      await writeFile(file, good);
      expect(typecheckSpecs([file]).get(file)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("allows literal member access and non-caseId exports; resolves the steps types", () => {
    const src = good
      .replace("res.status, plan", 'res["status"], plan')
      .replace("export async function run", "export const note = 1;\nexport async function run");
    expect(checkSpecSource(src, "TC-02", plan)).toEqual([]);
    expect(stepsTypesEntry(() => true)).toMatch(/steps\/src\/index\.ts$/);
    expect(stepsTypesEntry(() => false)).toMatch(/steps\/dist\/index\.d\.ts$/);
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

describe("manual steps in specs (REQ-EXEC-11)", () => {
  const first = plan.cases[0];
  if (!first) throw new Error("fixture");
  const manualPlan = PlanSchema.parse({
    ...plan,
    cases: [
      {
        ...first,
        steps: [
          ...first.steps,
          {
            id: "S9",
            action: "Check the printout",
            manual: true,
            instructions: "Print the receipt",
            expect: { description: "Total 1.01 printed" },
          },
        ],
      },
    ],
  });
  const tc1 = readFileSync(new URL("../../../fixtures/specs/demo-1/TC-01.spec.ts", import.meta.url), "utf8");
  const withManual = (body: string) => tc1.replace(/\n}\s*$/, `\n  await step("S9", () => {${body}});\n}\n`);

  it("REQ-EXEC-11/AC1: a manual step needs its step() call with no verify(); verifying it is rejected", () => {
    expect(checkSpecSource(withManual(""), "TC-01", manualPlan)).toEqual([]);
    expect(checkSpecSource(tc1, "TC-01", manualPlan).map((p) => p.message)).toContain(
      'plan step S9 has no step("S9") call',
    );
    expect(
      checkSpecSource(
        withManual(' verify("S9", "description", 1, plan.expect("TC-01.S9.description")); '),
        "TC-01",
        manualPlan,
      ).map((p) => p.message),
    ).toContain("step S9 is manual: a person reports its outcome, the spec must not verify it");
  });

  describe("native app cases (REQ-EXEC-06)", () => {
    const mobilePlan = PlanSchema.parse({
      schema: 1,
      ticket: "DEMO-6",
      version: 1,
      ...JSON.parse(
        readFileSync(new URL("../../../fixtures/plans/demo-6-draft.json", import.meta.url), "utf8"),
      ),
    });
    const mobile = readFileSync(
      new URL("../../../fixtures/specs/demo-6/TC-01.spec.ts", import.meta.url),
      "utf8",
    );
    const at = (src: string, options?: { deepLinks?: boolean }) =>
      checkSpecSource(src, "TC-01", mobilePlan, options).map((p) => `${p.check}: ${p.message}`);

    it("REQ-EXEC-06/AC1: the reference mobile spec passes", () => {
      expect(at(mobile)).toEqual([]);
    });

    it("REQ-EXEC-06/AC1: web-only operations and selectors are rejected before the run, with what to do instead", () => {
      const src = mobile.replace(
        'await ui.click("testid:add-item");',
        'await ui.as("user:standard");\n    await ui.goto("/app/cart");\n    await ui.select("css:#size", "M");\n    await ui.click("role:button:Add");\n    await ui.click("testid:add-item");',
      );
      expect(at(src)).toEqual([
        "lint: ui.as() does not exist in a native app: log in through the app's own screens with ui.fill and ui.click",
        "lint: ui.goto() in a native app needs mobile.deep_link_scheme; the app is already open: tap its elements instead",
        "lint: ui.select() does not exist in a native app: tap the option with ui.click",
        "lint: 'css:#size' cannot be found in a native app: use testid:, label:, text:, id: or xpath:",
        "lint: 'role:button:Add' cannot be found in a native app: use testid:, label:, text:, id: or xpath:",
      ]);
      expect(blockingProblems(checkSpecSource(src, "TC-01", mobilePlan)).length).toBe(5);
    });

    it("REQ-EXEC-06/AC1: ui.goto is allowed with a deep link scheme; web cases keep every operation", () => {
      const src = mobile.replace(
        'await ui.click("testid:add-item");',
        'await ui.goto("/cart");\n    await ui.click("testid:add-item");',
      );
      expect(at(src, { deepLinks: true })).toEqual([]);
      const web = readFileSync(
        new URL("../../../fixtures/specs/demo-4/TC-01.spec.ts", import.meta.url),
        "utf8",
      );
      const webPlan = PlanSchema.parse({
        schema: 1,
        ticket: "DEMO-4",
        version: 1,
        ...JSON.parse(
          readFileSync(new URL("../../../fixtures/plans/demo-4-draft.json", import.meta.url), "utf8"),
        ),
      });
      expect(checkSpecSource(web, "TC-01", webPlan)).toEqual([]);
      expect(web).toContain("ui.as(");
    });
  });

  it("REQ-EXEC-21/AC3+AC6: each platform takes its own selector kinds; css: and xpath: are flagged for review", () => {
    const mobilePlan = PlanSchema.parse({
      schema: 1,
      ticket: "DEMO-6",
      version: 1,
      ...JSON.parse(
        readFileSync(new URL("../../../fixtures/plans/demo-6-draft.json", import.meta.url), "utf8"),
      ),
    });
    const mobile = readFileSync(
      new URL("../../../fixtures/specs/demo-6/TC-01.spec.ts", import.meta.url),
      "utf8",
    );
    const native = checkSpecSource(
      mobile.replace(
        'await ui.click("testid:add-item");',
        'await ui.click("id:add_item");\n    await ui.click("xpath://android.widget.Button[1]");',
      ),
      "TC-01",
      mobilePlan,
    );
    expect(native.map((p) => `${p.check}: ${p.message}`)).toEqual([
      "review: XPath selector 'xpath://android.widget.Button[1]' is brittle; prefer testid:, label: or text:",
    ]);
    const webPlan = PlanSchema.parse({
      schema: 1,
      ticket: "DEMO-4",
      version: 1,
      ...JSON.parse(
        readFileSync(new URL("../../../fixtures/plans/demo-4-draft.json", import.meta.url), "utf8"),
      ),
    });
    const web = readFileSync(
      new URL("../../../fixtures/specs/demo-4/TC-01.spec.ts", import.meta.url),
      "utf8",
    );
    const kinds = checkSpecSource(
      web.replace(
        'await ui.check("testid:accept-terms");',
        'await ui.fill("placeholder:Email", "a");\n    await ui.click("alt:Logo");\n    await ui.click("title:Help");\n    await ui.click("id:terms");\n    await ui.click("xpath://b");\n    await ui.check("testid:accept-terms");',
      ),
      "TC-01",
      webPlan,
    );
    expect(kinds.map((p) => `${p.check}: ${p.message}`)).toEqual([
      "lint: 'xpath://b' cannot be found in a browser: use testid:, role:, label:, placeholder:, alt:, title:, text:, id: or css:",
    ]);
  });

  it("REQ-EXEC-03/AC2: a verify() of something the plan does not expect is rejected before the run", () => {
    const mobilePlan = PlanSchema.parse({
      schema: 1,
      ticket: "DEMO-6",
      version: 1,
      ...JSON.parse(
        readFileSync(new URL("../../../fixtures/plans/demo-6-draft.json", import.meta.url), "utf8"),
      ),
    });
    const mobile = readFileSync(
      new URL("../../../fixtures/specs/demo-6/TC-01.spec.ts", import.meta.url),
      "utf8",
    );
    const invented = mobile.replace(
      'await ui.click("testid:add-item");',
      'await ui.click("testid:add-item");\n    verify("S1", "elements.testid:cart-badge.text", undefined, plan.expect("TC-01.S1.elements.testid:cart-badge.text"));',
    );
    expect(checkSpecSource(invented, "TC-01", mobilePlan).map((p) => `${p.check}: ${p.message}`)).toEqual([
      'coverage: verify("S1", "elements.testid:cart-badge.text", ...) checks something step S1 of the plan does not expect; it expects: elements.testid:cart-count.text',
    ]);
  });

  it("REQ-EXEC-01/AC1: steps that only verify are found; ui, API and inbox calls are actions, plan.expect is not", () => {
    const spec = [
      'await step("S1", async () => { verify("S1", "elements.testid:a.text", undefined, plan.expect("TC-01.S1.elements.testid:a.text")); });',
      'await step("S2", async () => { await ui.click("testid:b"); });',
      'await step("S3", async () => { const r = await api.as("user:standard").get("/cart"); verify("S3", "status", r.status, plan.expect("TC-01.S3.status")); });',
      'await step("S4", async () => { const m = await inbox.wait("S4"); });',
      'await step("S5", () => {});',
    ].join("\n");
    expect(stepsWithoutActions(spec)).toEqual(["S1", "S5"]);
  });

  it("REQ-EXEC-03/AC5: a case that runs as a test account must log in as it; a spec that does not is refused before it runs", () => {
    const tc01 = readFileSync(
      new URL("../../../fixtures/specs/demo-1/TC-01.spec.ts", import.meta.url),
      "utf8",
    );
    expect(checkSpecSource(tc01, "TC-01", plan)).toEqual([]);
    // Exploratory testing F21: gemma4 wrote api.get("/cart") for a case with data.user; every call got 401 and
    // the case ended FAILED as if the cart were broken.
    const anonymous = tc01
      .replace('  const shopper = api.as("user:standard");\n', "")
      .replaceAll("shopper.", "api.");
    expect(checkSpecSource(anonymous, "TC-01", plan)).toEqual([
      {
        check: "coverage",
        message:
          'TC-01 runs as user:standard (data.user in the plan) but the spec never logs in as it: use api.as("user:standard") for its calls',
      },
    ]);
    // Another account than the plan's is no login as it either.
    expect(
      checkSpecSource(tc01.replace('api.as("user:standard")', 'api.as("user:admin")'), "TC-01", plan),
    ).toHaveLength(1);
  });
});
