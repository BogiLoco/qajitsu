import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildProject } from "../../../../tests/support/cli-build.js";
import { flowScript } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("numbers written as text in qj plan (REQ-PLAN-12)", () => {
  it("REQ-PLAN-12/AC1+AC3: the planner's '1.01' for a number field is stored as 1.01, listed next to the plan and journaled, without a revision round", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    const yaml = join(p.project, ".qa", "qa.project.yaml");
    const config = await readFile(yaml, "utf8");
    expect(config).toContain("path: demo-org/demo-shop }");
    await writeFile(
      yaml,
      config.replace("path: demo-org/demo-shop }", "path: demo-org/demo-shop, openapi: api/openapi.yaml }"),
    );
    await p.run(["fetch", "DEMO-1"]);
    const [analysis, draft] = flowScript("DEMO-1");
    const plan = JSON.parse((draft as { text: string }).text) as {
      cases: { data?: Record<string, string>; steps: { expect: { fields?: Record<string, unknown> } }[] }[];
    };
    // Every call of the demo API needs a login (REQ-PLAN-09/AC9); the first expectation is written as text.
    for (const c of plan.cases) c.data = { ...c.data, user: "user:standard" };
    const first = plan.cases[0]?.steps[0];
    if (first) first.expect.fields = { total: "1.01" };
    const asText = JSON.stringify(plan);
    expect(asText).toContain('"total":"1.01"');
    const r = await p.run(["plan", "DEMO-1"], [analysis as never, { text: asText }]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain(
      'Numbers written as text, converted by code (1):\n  ~ TC-01 S1 fields.total: "1.01" → 1.01 (GET /cart 200: number)',
    );
    expect(r.out).not.toContain("Cannot be checked as written");
    // One planner call: nothing was sent back for what code converts itself.
    expect(r.model.mock.doGenerateCalls).toHaveLength(2);
    const runs = join(p.home, "runs", "DEMO-1");
    const runDir = join(
      runs,
      (await readFile(join(runs, "index.json"), "utf8").then((t) => JSON.parse(t) as { latest: string }))
        .latest,
    );
    expect(await readFile(join(runDir, "plan", "plan.v1.yaml"), "utf8")).toMatch(/total: 1\.01\n/);
    const journal = await readFile(join(runDir, "journal", "events.jsonl"), "utf8");
    expect(journal).toContain('"event":"plan.converted"');
    const approved = await p.run(["approve", "DEMO-1"]);
    expect(approved.exitCode).toBe(0);
  }, 120_000);
});
