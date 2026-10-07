import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { analysis, apiService, createBuildProject, draft } from "../../../../tests/support/cli-build.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** The DEMO-1 draft with TC-02 lowered to medium, so depths differ. */
const mixedDraft = (): string => {
  const plan = JSON.parse(draft) as { cases: { priority: string }[] };
  if (plan.cases[1]) plan.cases[1].priority = "medium";
  return JSON.stringify(plan);
};

describe("test depth (REQ-PLAN-08/AC1)", () => {
  it("REQ-PLAN-08/AC1: --depth smoke keeps the high-risk case, records the depth and why each case is in or out; revisions keep it", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    await p.run(["fetch", "DEMO-1"]);
    expect((await p.run(["plan", "DEMO-1", "--depth", "deep"])).err).toContain("[PLAN_DEPTH_INVALID]");
    const planned = await p.run(
      ["plan", "DEMO-1", "--depth", "smoke"],
      [{ text: analysis }, { text: mixedDraft() }],
    );
    expect(planned.exitCode).toBe(0);
    expect(planned.out).toContain("Plan v1: 1 case(s)");
    const run = JSON.parse(await readFile(join(p.home, "runs", "DEMO-1", "index.json"), "utf8")) as {
      latest: string;
    };
    const dir = join(p.home, "runs", "DEMO-1", run.latest);
    const v1 = parse(await readFile(join(dir, "plan", "plan.v1.yaml"), "utf8")) as {
      depth: string;
      cases: { id: string }[];
      selection: { case: string; included: boolean; reason: string }[];
      out_of_scope: string[];
    };
    expect(v1.depth).toBe("smoke");
    expect(v1.cases.map((c) => c.id)).toEqual(["TC-01"]);
    expect(v1.selection).toMatchObject([
      { case: "TC-01", included: true, reason: "priority high is part of depth smoke" },
      { case: "TC-02", included: false, reason: "priority medium is below depth smoke" },
    ]);
    expect(v1.out_of_scope).toContain(
      "TC-02 Second code replaces the first (priority medium is below depth smoke)",
    );
    expect(await readFile(join(dir, "plan", "plan.v1.md"), "utf8")).toContain("Depth: **smoke**");
    // A revision of the same run keeps the depth chosen for it.
    await p.run(["plan", "DEMO-1", "--revise", "keep it short"], [{ text: mixedDraft() }]);
    expect(
      (parse(await readFile(join(dir, "plan", "plan.v2.yaml"), "utf8")) as { depth: string }).depth,
    ).toBe("smoke");
  }, 120_000);
});

describe("estimate and budget (REQ-PLAN-08/AC2+AC3)", () => {
  it("REQ-PLAN-08/AC2: before a run the time and model use are estimated, from past runs once there are some", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    await p.prepare();
    const first = await p.run(["run", "DEMO-1", "--build"]);
    expect(first.out).toContain(
      "Estimate: 2 api execution(s) ≈ 10 s; model use unknown (no past runs with usage); default timings, no past runs yet.",
    );
    await p.prepare();
    const second = await p.run(["run", "DEMO-1", "--build"]);
    expect(second.out).toMatch(
      /Estimate: 2 api execution\(s\) ≈ \d+ s; models ≈ \d+k tokens; from 1 past run\(s\)\./,
    );
  }, 240_000);

  it("REQ-PLAN-08/AC3: when the time budget is reached the remaining cases are NOT_RUN with the reason", async () => {
    let t = Date.parse("2026-10-07T10:00:00Z");
    // Every clock read moves 20 s on, so a 1-minute budget runs out during the run.
    const p = await createBuildProject(`${apiService()}\nbudget: { max_minutes: 1 }`, {
      now: () => new Date((t += 20_000)),
    });
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    const r = await p.run(["run", "DEMO-1", "--build"]);
    const results = (
      JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as {
        data: { results: Record<string, string> };
      }
    ).data.results;
    expect(Object.values(results)).toContain("NOT_RUN");
    expect(Object.values(results)).not.toContain("PASSED");
    const notRun = Object.entries(results).find(([, s]) => s === "NOT_RUN")?.[0] ?? "";
    expect(await readFile(join(dir, "results", `${notRun}.json`), "utf8")).toContain(
      "the run's time budget (1 min) was reached",
    );
    expect(r.exitCode).not.toBe(0);
  }, 240_000);

  it("REQ-PLAN-08/AC3: when the cost budget is reached no further spec is written; that case is NOT_RUN", async () => {
    const p = await createBuildProject(`${apiService()}\nbudget: { max_cost_usd: 0.5 }`);
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    await rm(join(dir, "specs", "TC-02.spec.ts"));
    // Planning already spent the budget.
    const runFile = join(dir, "run.json");
    const record = JSON.parse(await readFile(runFile, "utf8")) as { data: Record<string, unknown> };
    record.data["costUsd"] = 0.75;
    await writeFile(runFile, JSON.stringify(record));
    await p.run(["run", "DEMO-1", "--build"]);
    const results = (
      JSON.parse(await readFile(runFile, "utf8")) as { data: { results: Record<string, string> } }
    ).data.results;
    expect(results).toEqual({ "TC-01": "PASSED", "TC-02": "NOT_RUN" });
    expect(await readFile(join(dir, "results", "TC-02.json"), "utf8")).toContain(
      "the run's cost budget ($0.50) was reached",
    );
  }, 240_000);
});
