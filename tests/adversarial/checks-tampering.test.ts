// REQ-VER-06, REQ-VER-09, invariants 1 and 5: the auditor and the canary only downgrade, and their records
// fail closed. Deleting, swapping or corrupting checks/*.json never brings back a PASSED they took away,
// and a lying auditor cannot make anything better.
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiService, createBuildProject } from "../support/cli-build.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const weakTc1 = JSON.stringify({
  findings: [
    { caseId: "TC-01", weak: true, reason: "evidence contradicts the pass" },
    { caseId: "TC-02", weak: false, reason: "fine" },
  ],
});

/** A run whose required auditor flagged TC-01; returns the run folder and a publish attempt. */
const audited = async () => {
  const p = await createBuildProject(`${apiService()}\nverification: { auditor: required }`);
  cleanups.push(p.cleanup);
  const dir = await p.prepare();
  expect((await p.run(["run", "DEMO-1", "--build"], [{ text: weakTc1 }])).exitCode).toBe(2);
  const publish = async () => {
    const r = await p.run(["publish", "DEMO-1"]);
    return { ...r, matrix: await readFile(join(dir, "report", "matrix.md"), "utf8") };
  };
  return { p, dir, publish };
};

describe("tampering with check records (REQ-VER-06, REQ-VER-09)", () => {
  it("deleting checks/audit.json does not bring PASSED back; publish is refused", async () => {
    const { dir, publish } = await audited();
    await rm(join(dir, "checks", "audit.json"));
    const r = await publish();
    expect(r.exitCode).toBe(3);
    expect(r.err).toContain("checks-intact");
    expect(r.matrix).not.toContain("| PASSED |");
    expect((r.matrix.match(/\| NEEDS_REVIEW \|/g) ?? []).length).toBe(2);
  }, 180_000);

  it("a swapped record (valid JSON, no findings) is caught by its hash", async () => {
    const { dir, publish } = await audited();
    const file = join(dir, "checks", "audit.json");
    const record = JSON.parse(await readFile(file, "utf8")) as { findings: unknown[] };
    await writeFile(file, JSON.stringify({ ...record, findings: [] }, null, 2));
    const r = await publish();
    expect(r.err).toContain("does not match the hash recorded in run.json");
    expect(r.matrix).not.toContain("| PASSED |");
  }, 180_000);

  it("a corrupted record fails closed instead of crashing", async () => {
    const { dir, publish } = await audited();
    await writeFile(join(dir, "checks", "audit.json"), "{ not json");
    const r = await publish();
    expect(r.exitCode).toBe(3);
    expect(r.err).not.toMatch(/SyntaxError|ZodError/);
    expect(r.err).toContain("checks-intact");
    expect(r.matrix).not.toContain("| PASSED |");
  }, 180_000);

  it("a lying auditor (findings for a FAILED case, an extra status field) changes nothing", async () => {
    const p = await createBuildProject(`${apiService()}\nverification: { auditor: optional }`);
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    const lie = JSON.stringify({
      findings: [
        { caseId: "TC-01", weak: false, reason: "all good", status: "PASSED" },
        { caseId: "TC-02", weak: false, reason: "all good" },
      ],
    });
    const result = await p.run(
      ["run", "DEMO-1", "--build", "--set", "api.BUG_CART_TOTAL_ROUNDING=1"],
      [{ text: lie }],
    );
    expect(result.exitCode).toBe(1);
    const run = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as {
      data: { results: Record<string, string> };
    };
    expect(run.data.results["TC-01"]).toBe("FAILED");
    expect(JSON.parse(await readFile(join(dir, "checks", "audit.json"), "utf8"))).toMatchObject({
      status: "failed",
    });
  }, 180_000);
});
