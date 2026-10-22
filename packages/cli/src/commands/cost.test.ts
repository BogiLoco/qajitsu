import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";
import type { Sample } from "./metrics.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("cost and time of runs in the CLI (REQ-LLM-11, REQ-NFR-11)", () => {
  it("REQ-LLM-11/AC2+AC4 + REQ-NFR-11/AC2+AC4: after a run, metrics and status show the cost per verified ticket and where the time went", async () => {
    // The scripted test model has no price: the cost is shown as a lower bound, never as an exact 0.
    // A clock that moves one second per reading, so stages take time; it starts in ISO week 40 of 2026.
    let tick = Date.parse("2026-10-03T10:46:00Z");
    const p = await createDemoPipeline({
      flag: "BUG_CART_TOTAL_ROUNDING",
      ports: { now: () => new Date((tick += 1000)) },
    });
    cleanups.push(p.cleanup);
    expect((await p.executed()).exitCode).toBe(1);
    const metrics = await p.run(["metrics", "--format", "json"]);
    const samples = JSON.parse(metrics.out.slice(metrics.out.indexOf("["))) as Sample[];
    const value = (name: string) => samples.find((s) => s.name === name);
    expect(value("qajitsu_verified_tickets")?.value).toBe(1);
    expect(value("qajitsu_cost_per_verified_ticket_usd")?.labels).toEqual({ cost_known: "0" });
    expect(samples.filter((s) => s.name === "qajitsu_role_cost_usd").map((s) => s.labels["role"])).toEqual(
      expect.arrayContaining(["analyst", "planner"]),
    );
    expect(value("qajitsu_week_cost_per_verified_ticket_usd")?.labels).toEqual({ week: "2026-W40" });
    const status = await p.run(["status"]);
    expect(status.out).toMatch(
      /Cost: \$\d.* over 1 run\(s\); 1 of 1 ticket\(s\) verified, \$[\d.]+ per verified ticket/,
    );
    expect(status.out).toMatch(/by role: (analyst|planner) \$/);
    expect(status.out).toContain("per verified ticket by week: 2026-W40");
    // REQ-NFR-11/AC2+AC4: where the time went, per stage, as metrics too.
    expect(status.out).toMatch(
      /Time per run \(median of 1\): [\dhms ]+ active: models [\dhms ]+, environment [\dhms ]+, tests [\dhms ]+, QAJitsu [\dhms ]+/,
    );
    expect(status.out).toMatch(/ {2}stages: .*plan .*run /);
    expect(
      samples.filter((s) => s.name === "qajitsu_run_time_seconds").map((s) => s.labels["category"]),
    ).toEqual(["active", "model", "environment", "tests", "qajitsu"]);
    expect(
      samples.some((s) => s.name === "qajitsu_stage_seconds_by_version" && s.labels["stage"] === "run"),
    ).toBe(true);
  }, 180_000);

  it("REQ-NFR-11/AC3: a stage over its configured budget is a warning with the measured time; statuses stay the same", async () => {
    let tick = Date.parse("2026-10-03T10:46:00Z");
    const p = await createDemoPipeline({
      flag: "BUG_CART_TOTAL_ROUNDING",
      config: ["timing: { budgets_s: { run: 5 } }"],
      ports: { now: () => new Date((tick += 1000)) },
    });
    cleanups.push(p.cleanup);
    const ran = await p.executed();
    expect(ran.err).toMatch(
      /Warning: stage run took [\dhms ]+, over its budget of 5s \(timing\.budgets_s\.run\); no status is affected\./,
    );
    expect(ran.exitCode).toBe(1);
    expect(ran.out).toContain("TC-01 FAILED");
  }, 180_000);
});
