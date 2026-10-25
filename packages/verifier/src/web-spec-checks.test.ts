import { readFileSync } from "node:fs";
import { PlanSchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { plannedFields } from "./expectations.js";
import { assertionLockDiff, checkSpecSource } from "./spec-checks.js";

const fixturePlan = (ticket: string) =>
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
const fixtureSpec = (ticket: string, id: string) =>
  readFileSync(
    new URL(`../../../fixtures/specs/${ticket.toLowerCase()}/${id}.spec.ts`, import.meta.url),
    "utf8",
  );
const messages = (source: string, caseId: string, plan: ReturnType<typeof fixturePlan>) =>
  checkSpecSource(source, caseId, plan).map((p) => `${p.check}: ${p.message}`);

describe("static checks of web actions (REQ-EXEC-38..40, REQ-EXEC-56, ADR-0013)", () => {
  it("REQ-EXEC-38..40 + REQ-EXEC-56: the reference specs of the web gaps pass every check", () => {
    for (const [ticket, ids] of [
      ["DEMO-7", ["TC-01", "TC-02", "TC-03"]],
      ["DEMO-8", ["TC-01"]],
      ["DEMO-9", ["TC-01", "TC-02", "TC-03", "TC-04"]],
    ] as const)
      for (const id of ids)
        expect(
          messages(fixtureSpec(ticket, id), id, fixturePlan(ticket)).filter((m) => !m.startsWith("review")),
          `${ticket} ${id}`,
        ).toEqual([]);
  });

  it("REQ-EXEC-38/AC1: uploads name files of the plan, as literals", () => {
    const plan = fixturePlan("DEMO-7");
    const spec = fixtureSpec("DEMO-7", "TC-01");
    expect(messages(spec.replace('"avatar"', '"secret-file"'), "TC-01", plan)).toContain(
      "coverage: ui.upload(): 'secret-file' is not a file of TC-01 in the plan (files)",
    );
    expect(
      messages(
        spec.replace('ui.upload("testid:avatar-input", "avatar")', 'ui.upload("testid:avatar-input")'),
        "TC-01",
        plan,
      ),
    ).toContain("lint: ui.upload() needs the plan keys of the files to upload");
    expect(
      messages(
        spec.replace(
          'ui.upload("testid:avatar-input", "avatar")',
          'ui.upload("testid:avatar-input", `avatar`)',
        ),
        "TC-01",
        plan,
      ),
    ).toContain("lint: ui.upload() takes literal file keys of the plan");
  });

  it("REQ-EXEC-38/AC2: a planned download needs ui.download() in its step, and every planned download field a verify()", () => {
    const plan = fixturePlan("DEMO-7");
    const spec = fixtureSpec("DEMO-7", "TC-03");
    expect(messages(spec.replace('await ui.download("testid:export-csv");', ""), "TC-03", plan)).toContain(
      'coverage: step S1 expects a download: call ui.download(<selector>) inside step("S1", ...)',
    );
    expect(messages(spec.replace(/verify\("S1", "download\.rows".*\n/, ""), "TC-03", plan)).toContain(
      'coverage: expectation S1 download.rows has no verify("S1", "download.rows", ...) call',
    );
    expect(plannedFields(plan.cases[2]?.steps[0]?.expect ?? { description: "" })).toEqual([
      "download.name",
      "download.type",
      "download.rows",
      "download.texts.0",
    ]);
    expect(
      plannedFields({
        description: "d",
        download: { min_bytes: 1, sha256: "a".repeat(64), fields: { "a.b": 1 } },
        state: { "x.y": 1 },
      }),
    ).toEqual(["download.size", "download.sha256", "download.fields.a.b", "state.x.y"]);
  });

  it("REQ-EXEC-39/AC1 + REQ-EXEC-40/AC1: frame selectors are browser selectors; both selectors of dragTo are checked", () => {
    const plan = fixturePlan("DEMO-9");
    const spec = fixtureSpec("DEMO-9", "TC-01");
    expect(messages(spec.replace('"testid:col-done"', '"xpath://section[3]"'), "TC-01", plan)).toContain(
      "lint: 'xpath://section[3]' cannot be found in a browser: use testid:, role:, label:, placeholder:, alt:, title:, text:, id:, css: or frame:<selector> >> <selector>",
    );
    expect(
      messages(fixtureSpec("DEMO-8", "TC-01"), "TC-01", fixturePlan("DEMO-8")).filter((m) =>
        m.startsWith("lint"),
      ),
    ).toEqual([]);
  });

  it("REQ-EXEC-38..40 + REQ-EXEC-64/AC4: web actions and selector chains are refused in a native app until its driver offers them", () => {
    const plan = PlanSchema.parse({
      schema: 1,
      ticket: "DEMO-6",
      version: 1,
      cases: [
        {
          id: "TC-01",
          title: "native",
          type: "mobile",
          priority: "high",
          source: [{ kind: "ac", id: "AC1" }],
          steps: [
            {
              id: "S1",
              action: "a",
              expect: { description: "d", elements: { "testid:a": { visible: true } } },
            },
          ],
          evidence: ["screenshot"],
        },
      ],
    });
    const spec = `import type { CaseContext } from "@qajitsu/steps";
export const caseId = "TC-01";
export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.hover("testid:a");
    await ui.scrollBy(0, 100);
    await ui.switchToNewPage();
    await ui.click("testid:list >> testid:a");
    verify("S1", "elements.testid:a.visible", undefined, plan.expect("TC-01.S1.elements.testid:a.visible"));
  });
}
`;
    expect(messages(spec, "TC-01", plan)).toEqual([
      "lint: ui.hover() is not available in native apps yet: it works in web cases",
      "lint: ui.scrollBy() is not available in native apps yet: it works in web cases",
      "lint: ui.switchToNewPage() is not available in native apps yet: it works in web cases",
      "lint: 'testid:list >> testid:a' is a selector chain, which native apps do not support yet: use one selector",
    ]);
  });

  it("REQ-EXEC-09: the healer may change the selectors of web actions and add scrolling into view, never their files or offsets", () => {
    const before = fixtureSpec("DEMO-9", "TC-01");
    expect(
      assertionLockDiff(
        before,
        before.replace(
          '"testid:card-1", "testid:col-done"',
          '"role:listitem:Write tests", "role:region:Done"',
        ),
      ),
    ).toEqual([]);
    expect(
      assertionLockDiff(
        before,
        before.replace("await ui.dragTo(", 'await ui.scrollTo("testid:card-1");\n    await ui.dragTo('),
      ),
    ).toEqual([]);
    const upload = fixtureSpec("DEMO-7", "TC-01");
    expect(assertionLockDiff(upload, upload.replace('"avatar"', '"big"'))).not.toEqual([]);
    expect(
      assertionLockDiff(
        before,
        before.replace("await ui.dragTo(", 'await ui.hover("testid:card-1");\n    await ui.dragTo('),
      ),
    ).not.toEqual([]);
  });

  it("REQ-EXEC-05 + REQ-EXEC-03/AC1: a web action before any page is open is refused before the run (dogfood 2026-10-25)", () => {
    const plan = fixturePlan("DEMO-9");
    const spec = fixtureSpec("DEMO-9", "TC-02");
    expect(messages(spec.replace('await ui.goto("/app/board");\n', ""), "TC-02", plan)).toContain(
      'lint: ui.hover() runs before any page is open: call ui.goto("<path>") first in the step',
    );
    expect(messages(spec, "TC-02", plan).filter((m) => m.includes("before any page"))).toEqual([]);
  });
});
