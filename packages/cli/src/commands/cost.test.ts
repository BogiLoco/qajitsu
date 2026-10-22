import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";
import type { Sample } from "./metrics.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("cost per verified ticket in the CLI (REQ-LLM-11)", () => {
  it("REQ-LLM-11/AC2+AC4: after a run, metrics and status show the cost per verified ticket, per role and per week", async () => {
    // The scripted test model has no price: the cost is shown as a lower bound, never as an exact 0.
    const p = await createDemoPipeline({ flag: "BUG_CART_TOTAL_ROUNDING" });
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
  }, 180_000);
});
