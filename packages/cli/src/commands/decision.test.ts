import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const executed = async (options: Parameters<typeof createDemoPipeline>[0] = {}) => {
  const p = await createDemoPipeline(options);
  cleanups.push(p.cleanup);
  const r = await p.executed();
  const report = (name: string) => readFile(join(p.runDir, "report", name), "utf8");
  return { p, r, report };
};

describe("GO / NO-GO in every report (REQ-PUB-10)", () => {
  it("REQ-PUB-10/AC1: a clean run is GO in the terminal, matrix, report.html and junit", async () => {
    const { r, report } = await executed();
    expect(r.out).toContain("**Decision: GO (policy v1)**");
    expect(await report("matrix.md")).toContain("**Decision: GO (policy v1)**");
    expect(await report("report.html")).toContain('<h2 class="ok">Decision: GO (policy v1)</h2>');
    expect(await report("junit.xml")).toContain('name="qajitsu.decision" value="Decision: GO (policy v1)"');
  }, 180_000);

  it("REQ-PUB-10/AC1+AC2+AC5: a FAILED must-have case is NO-GO with its cause, also in the ticket comment", async () => {
    const { p, r } = await executed({ flag: "BUG_CART_TOTAL_ROUNDING" });
    expect(r.out).toContain("**Decision: NO-GO (policy v1): TC-01 FAILED (high)**");
    expect((await p.run(["evidence", "DEMO-1", "--failed"])).out).toContain(
      "Decision: NO-GO (policy v1): TC-01 FAILED (high)",
    );
    expect((await p.run(["export", "DEMO-1", "--out", "x"])).out).toContain(
      "Decision: NO-GO (policy v1): TC-01 FAILED (high)",
    );
    const published = await p.run(["publish", "DEMO-1", "--auto-publish"]);
    expect(published.exitCode).not.toBe(3);
    expect(await readFile(join(p.runDir, "report", "published", "jira-comment.adf.json"), "utf8")).toContain(
      "Decision: NO-GO (policy v1): TC-01 FAILED (high)",
    );
  }, 180_000);

  it("REQ-PUB-10/AC3: the project's policy can tolerate a FAILED low-priority case; its version is shown", async () => {
    const lowFirst = (d: string) => d.replace('"priority": "high"', '"priority": "low"');
    const { r } = await executed({
      flag: "BUG_CART_TOTAL_ROUNDING",
      transformPlan: lowFirst,
      config: ["decision: { version: '2026-10', tolerate: { low: [FAILED] } }"],
    });
    expect(r.out).toContain(
      "**Decision: GO (policy v2026-10); tolerated by the policy: TC-01 FAILED (low)**",
    );
  }, 180_000);
});
