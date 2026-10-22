import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline, DEMO_PASSWORD } from "../../../../tests/support/cli-pipeline.js";
import type { Sample } from "./metrics.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("plan quality metrics and the agent scorecard (REQ-PLAN-16, REQ-LLM-14)", () => {
  it("REQ-PLAN-16/AC2+AC3+AC4 + REQ-LLM-14/AC3: a person's feedback counts false FAILED and escaped defects; status and metrics show them with the scorecard", async () => {
    const p = await createDemoPipeline({ flag: "BUG_CART_TOTAL_ROUNDING" });
    cleanups.push(p.cleanup);
    expect((await p.executed()).exitCode).toBe(1);

    // Only FAILED cases can be judged, with one of four kinds; an escaped defect is a ticket key.
    expect((await p.run(["feedback", "DEMO-1", "--case", "TC-02", "--is", "test-bug"])).err).toContain(
      "FEEDBACK_NOT_FAILED",
    );
    expect((await p.run(["feedback", "DEMO-1", "--case", "TC-01", "--is", "flaky"])).err).toContain(
      "FEEDBACK_KIND",
    );
    expect((await p.run(["feedback", "DEMO-1", "--escaped", "nope"])).err).toContain("TICKET_KEY_INVALID");
    expect((await p.run(["feedback", "DEMO-1"])).err).toContain("FEEDBACK_KIND");

    const judged = await p.run([
      "feedback",
      "DEMO-1",
      "--case",
      "TC-01",
      "--is",
      "test-bug",
      "--note",
      `rounding is right, the plan was wrong (${DEMO_PASSWORD})`,
    ]);
    expect(judged.out).toContain(
      "Recorded TC-01 of DEMO-1 (run 20261003-1046-aaaa) as test-bug; its status stays FAILED.",
    );
    expect((await p.run(["feedback", "DEMO-1", "--escaped", "DEMO-9"])).exitCode).toBe(0);
    const record = await readFile(join(p.runDir, "run.json"), "utf8");
    expect(record).toContain('"TC-01": "FAILED"');
    expect(record).not.toContain(DEMO_PASSWORD);

    const status = await p.run(["status"]);
    expect(status.out).toContain("Plans: 1 approved, 100% without changes, 0.0 revision round(s) on average");
    expect(status.out).toContain(
      "Tests: 1 FAILED, 1 found to be no product bug (100%, qj feedback); auditor downgraded 0 PASSED; 1 escaped defect(s)",
    );
    expect(status.out).toMatch(/ {2}analyst mock\/scripted: \d+ call\(s\), p95 \S+, \d+% without repair/);
    expect(status.out).toContain("  planner: ");

    const metrics = await p.run(["metrics", "--format", "json"]);
    const samples = JSON.parse(metrics.out.slice(metrics.out.indexOf("["))) as Sample[];
    const value = (name: string) => samples.find((s) => s.name === name)?.value;
    expect(value("qajitsu_false_failed_recorded_ratio")).toBe(1);
    expect(value("qajitsu_escaped_defects")).toBe(1);
    expect(value("qajitsu_plan_accepted_unchanged_ratio")).toBe(1);
    expect(samples.some((s) => s.name === "qajitsu_agent_calls" && s.labels["role"] === "planner")).toBe(
      true,
    );
  }, 180_000);
});
