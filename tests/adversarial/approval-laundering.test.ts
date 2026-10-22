// Adversarial suite: someone edits the approved plan before the run and writes its new hash into run.json, so the
// file and the record agree. Found in the second exploratory pass: the run executed the edited plan (only the gate
// and the certificate caught it afterwards).
// Scenario catalogue: .claude/skills/adversarial-test/scenarios.md
import { copyFile, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline, flowScript } from "../support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("a laundered approved plan never runs (invariant 3, REQ-PLAN-06)", () => {
  it("REQ-PLAN-10/AC6 + REQ-VER-16/AC4: a plan file and run.json hash edited together are refused before anything runs", async () => {
    const p = await createDemoPipeline({ flag: "BUG_CART_TOTAL_ROUNDING" });
    cleanups.push(p.cleanup);
    await p.run(["fetch", "DEMO-1"]);
    await p.run(["plan", "DEMO-1"], { script: flowScript("DEMO-1") });
    expect((await p.run(["approve", "DEMO-1"])).exitCode).toBe(0);
    for (const id of ["TC-01", "TC-02"])
      await copyFile(
        new URL(`../../fixtures/specs/demo-1/${id}.spec.ts`, import.meta.url),
        join(p.runDir, "specs", `${id}.spec.ts`),
      );
    // The expected total of the buggy case becomes the buggy value, and the record is made to agree.
    const planFile = join(p.runDir, "plan", "plan.approved.yaml");
    const laundered = (await readFile(planFile, "utf8")).replace("total: 1.01", "total: 1.02");
    expect(laundered).toContain("total: 1.02");
    await writeFile(planFile, laundered);
    const recordFile = join(p.runDir, "run.json");
    const record = JSON.parse(await readFile(recordFile, "utf8")) as {
      data: { approval: { sha256: string } };
    };
    record.data.approval.sha256 = sha256(laundered);
    await writeFile(recordFile, JSON.stringify(record, null, 2));

    const ran = await p.run(["run", "DEMO-1"]);
    expect(ran.exitCode).toBe(3);
    expect(ran.err).toContain("APPROVAL_RECORD_MISMATCH");
    expect(ran.err).toContain(`no approval step approved plan sha256 ${sha256(laundered).slice(0, 12)}`);
    expect(await readdir(join(p.runDir, "results"))).toEqual([]);
  }, 180_000);
});
