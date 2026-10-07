import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline, flowScript } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const pipeline = async (flag?: string) => {
  const p = await createDemoPipeline(flag ? { flag } : {});
  cleanups.push(p.cleanup);
  return p;
};
const runJson = async (dir: string) =>
  JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as { data: Record<string, unknown> };

describe("qajitsu test: the whole flow in one command (REQ-GEN-05/AC2)", () => {
  it("REQ-GEN-05/AC2 + REQ-VER-10/AC1: fetch, plan, approval, run and publish after the preview; exit code from the statuses", async () => {
    const { run, runDir } = await pipeline("BUG_CART_TOTAL_ROUNDING");
    const result = await run(["test", "DEMO-1"], { script: flowScript("DEMO-1"), ask: ["a", "y"] });
    expect(result.err).not.toContain("Error");
    expect(result.exitCode).toBe(1);
    expect(result.out).toContain("| TC-01 | Cart total is rounded once | AC1 | API | FAILED |");
    expect(result.out).toContain("Published DEMO-1 comment");
    const record = await runJson(runDir);
    expect(record.data["approval"]).toMatchObject({ approver: "qa-lead" });
    expect(record.data["publish"]).toMatchObject({ preview: "confirmed" });
  }, 120_000);

  it("REQ-GEN-05/AC2: --dry-run stops before publishing", async () => {
    const { run, runDir } = await pipeline();
    const result = await run(["test", "DEMO-1", "--dry-run"], { script: flowScript("DEMO-1"), ask: ["a"] });
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain("Dry run: results not published");
    expect((await runJson(runDir)).data["publish"]).toBeUndefined();
  }, 120_000);

  it("REQ-GEN-05/AC2 + REQ-PLAN-04: without an approved plan nothing runs and the exit code is 2", async () => {
    const { run, runDir } = await pipeline();
    const quit = await run(["test", "DEMO-1"], { script: flowScript("DEMO-1"), ask: ["q"] });
    expect(quit.exitCode).toBe(2);
    expect(quit.out).toContain("The plan is not approved");
    expect(await readdir(join(runDir, "results"))).toEqual([]);
  }, 120_000);

  it("REQ-GEN-05/AC2: a failing stage stops the flow with its exit code", async () => {
    const { run } = await pipeline();
    const result = await run(["test", "NOPE-1"], { script: flowScript("DEMO-1"), ask: ["a", "y"] });
    expect(result.exitCode).toBe(3);
    expect(result.out).not.toContain("Published");
  }, 120_000);
});
