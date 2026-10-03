import { readFileSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { PlanSchema, createEventLog } from "@qajitsu/core";
import { describe, expect, it, afterEach } from "vitest";
import { promptOf, scriptedModel } from "../../../tests/support/mock-model.js";
import { createFetchedRun } from "../../../tests/support/run-fixture.js";
import { AUTHOR_MAX_ATTEMPTS, extractCode, runAuthor } from "./author.js";
import { buildChangeContext } from "./context.js";
import type { AgentStageDeps } from "./roles-run.js";
import { createUsageTracker } from "./usage.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-1",
  version: 1,
  ...JSON.parse(readFileSync(new URL("../../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8")),
});
const spec = (id: string) =>
  readFileSync(new URL(`../../../fixtures/specs/demo-1/${id}.spec.ts`, import.meta.url), "utf8");
const analysis = {
  summary: "s",
  change_type: ["api" as const],
  endpoints: [{ method: "GET", path: "/cart", source: [{ kind: "ac" as const, id: "AC1" }] }],
  screens: [],
  risks: [],
  confidence: "high" as const,
  open_questions: [],
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const deps = async (model: ReturnType<typeof scriptedModel>) => {
  const { root, ws } = await createFetchedRun();
  roots.push(root);
  const events = createEventLog({
    ticket: "DEMO-1",
    run: ws.runId,
    write: () => undefined,
    now: () => new Date(0),
    mask: (v) => v,
  });
  const d: AgentStageDeps = {
    ws,
    models: { forRole: () => Promise.resolve(model), resolve: () => Promise.resolve(model) },
    events,
    usage: createUsageTracker({ events }),
    now: () => new Date(0),
    maskJson: (v) => v,
    maskText: (t) => t,
  };
  return { d, ws, context: await buildChangeContext(ws) };
};

describe("author (REQ-EXEC-01, REQ-EXEC-03/AC4)", () => {
  it("REQ-EXEC-01/AC1: writes one checked spec per approved case under specs/", async () => {
    const model = scriptedModel([
      { text: "```ts\n" + spec("TC-01") + "```" },
      { text: "```ts\n" + spec("TC-02") + "```" },
    ]);
    const { d, ws, context } = await deps(model);
    const result = await runAuthor(d, plan, context, analysis, ["user:standard"]);
    expect(result.map((r) => [r.caseId, r.attempts, r.problems.length])).toEqual([
      ["TC-01", 1, 0],
      ["TC-02", 1, 0],
    ]);
    expect(await readFile(ws.path("specs", "TC-01.spec.ts"), "utf8")).toBe(spec("TC-01"));
    expect(promptOf(model, 0)).toContain("Account aliases available: user:standard");
  });

  it("REQ-EXEC-03/AC4: a rejected spec returns to the author with the errors", async () => {
    const literal = spec("TC-01").replace('plan.expect("TC-01.S1.fields.total")', "1.01");
    const model = scriptedModel([
      { text: "```ts\n" + literal + "```" },
      { text: "```ts\n" + spec("TC-01") + "```" },
      { text: "```ts\n" + spec("TC-02") + "```" },
    ]);
    const { d, context } = await deps(model);
    const result = await runAuthor(d, plan, context, analysis, ["user:standard"]);
    expect(result[0]).toMatchObject({ caseId: "TC-01", attempts: 2, problems: [] });
    expect(promptOf(model, 1)).toContain("assertion-lock");
  });

  it("REQ-EXEC-03/AC4: after 2 failed attempts no spec is written (the case ends BLOCKED)", async () => {
    const model = scriptedModel([{ text: "no code here" }]);
    const { d, ws, context } = await deps(model);
    const result = await runAuthor(d, { ...plan, cases: plan.cases.slice(0, 1) }, context, analysis, []);
    expect(result).toEqual([
      {
        caseId: "TC-01",
        attempts: AUTHOR_MAX_ATTEMPTS,
        problems: [{ check: "lint", message: "answer contained no ```ts code block" }],
      },
    ]);
    await expect(stat(ws.path("specs", "TC-01.spec.ts"))).rejects.toThrow();
  });

  it("REQ-EXEC-03/AC1: a spec that does not type-check is rejected", async () => {
    const typo = spec("TC-01").replace("api.as(", "api.ass(");
    const model = scriptedModel([{ text: "```ts\n" + typo + "```" }]);
    const { d, context } = await deps(model);
    const [first] = await runAuthor(d, { ...plan, cases: plan.cases.slice(0, 1) }, context, analysis, [
      "user:standard",
    ]);
    expect(first?.problems[0]?.check).toBe("typecheck");
  });

  it("extracts fenced code", () => {
    expect(extractCode("x\n```typescript\nconst a = 1;\n```\n")).toBe("const a = 1;\n");
    expect(extractCode("```ts\n\n```")).toBeUndefined();
  });
});
