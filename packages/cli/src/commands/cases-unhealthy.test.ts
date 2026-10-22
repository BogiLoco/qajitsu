import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline, flowScript } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("--cases with an environment that is not healthy (REQ-EXEC-16/AC1)", () => {
  // Exploratory pass E6: the unhealthy branch made every case BLOCKED, also those not chosen with --cases.
  it("REQ-EXEC-16/AC1 + REQ-ENV-01/AC1: the chosen cases are BLOCKED, the others NOT_RUN", async () => {
    const p = await createDemoPipeline();
    cleanups.push(p.cleanup);
    // The environment points at a closed port before planning, so the approval context stays the same.
    const unreachable = "http://127.0.0.1:9";
    for (const file of [
      join(p.project, ".qa", "qa.project.yaml"),
      join(p.project, ".qa", "envs", "local.yaml"),
    ]) {
      const text = await readFile(file, "utf8");
      await writeFile(file, text.replace(/http:\/\/127\.0\.0\.1:\d+/g, unreachable));
    }
    await p.run(["fetch", "DEMO-1"]);
    await p.run(["plan", "DEMO-1"], { script: flowScript("DEMO-1") });
    expect((await p.run(["approve", "DEMO-1"])).exitCode).toBe(0);
    for (const id of ["TC-01", "TC-02"])
      await copyFile(
        new URL(`../../../../fixtures/specs/demo-1/${id}.spec.ts`, import.meta.url),
        join(p.runDir, "specs", `${id}.spec.ts`),
      );
    const ran = await p.run(["run", "DEMO-1", "--cases", "TC-01"]);
    expect(ran.err).toContain("is not healthy");
    const record = JSON.parse(await readFile(join(p.runDir, "run.json"), "utf8")) as {
      data: { results: Record<string, string> };
    };
    expect(record.data.results).toEqual({ "TC-01": "BLOCKED", "TC-02": "NOT_RUN" });
  }, 180_000);
});
