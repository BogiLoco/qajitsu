// Adversarial suite: a spec that tries to use a planned wait to pass a check that never held, or to wait where the
// plan does not (REQ-EXEC-46, invariants 1 and 4).
import { PlanSchema } from "@qajitsu/core";
import { createCaseRuntime, createMasker } from "@qajitsu/steps";
import { describe, expect, it } from "vitest";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-16",
  version: 1,
  summary: "Document processing.",
  cases: [
    {
      id: "TC-01",
      title: "A document becomes ready",
      type: "api",
      priority: "high",
      source: [{ kind: "ac", id: "AC4" }],
      steps: [
        { id: "S1", action: "GET /documents/D-1", expect: { description: "Stored", status: 200 } },
        {
          id: "S2",
          action: "GET /documents/D-1",
          wait: { timeout_s: 6, interval_s: 2 },
          expect: { description: "Ready", status: 200, fields: { status: "ready" } },
        },
      ],
      evidence: ["response"],
    },
  ],
  open_questions: [],
  out_of_scope: [],
});

const runtime = () => {
  let t = 0;
  const sleeps: number[] = [];
  const r = createCaseRuntime({
    plan,
    caseId: "TC-01",
    attempt: 1,
    baseUrl: "http://127.0.0.1:3000",
    transport: () =>
      Promise.resolve({
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({ status: "processing" }),
      }),
    masker: createMasker(),
    allowedOrigins: ["http://127.0.0.1:3000"],
    accounts: {},
    now: () => t,
    sleep: (ms) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
  });
  return { ...r, sleeps };
};

describe("a planned wait cannot launder a check that never held (REQ-EXEC-46)", () => {
  it("invariant 1 + REQ-EXEC-46/AC3: a later round that leaves out the failing check does not count as met", async () => {
    const r = runtime();
    let round = 0;
    await r.context.step("S2", async () => {
      round += 1;
      const res = await r.context.api.get("/documents/D-1");
      r.context.verify("S2", "status", res.status, r.context.plan.expect("TC-01.S2.status"));
      // From the second round on the spec "forgets" the check that keeps failing.
      if (round === 1)
        r.context.verify(
          "S2",
          "fields.status",
          res.json("status"),
          r.context.plan.expect("TC-01.S2.fields.status"),
        );
    });
    const record = await r.finish();
    expect(record.steps[0]?.wait?.met).toBe(false);
    expect(record.outcome).not.toBe("passed");
  });

  it("invariant 4 + REQ-EXEC-46/AC1: only the plan makes a step wait; a step without one is checked once", async () => {
    const r = runtime();
    let rounds = 0;
    await r.context.step("S1", async () => {
      rounds += 1;
      const res = await r.context.api.get("/documents/D-1");
      r.context.verify("S1", "status", 500, r.context.plan.expect("TC-01.S1.status"));
      expect(res.status).toBe(200);
    });
    expect(rounds).toBe(1);
    expect(r.sleeps).toEqual([]);
    expect(r.pollRound("S1")).toEqual({ again: false, delayMs: 0 });
  });

  it("REQ-EXEC-46/AC3: a wait ends at the plan's timeout however the spec behaves", async () => {
    const r = runtime();
    await r.context.step("S2", async () => {
      const res = await r.context.api.get("/documents/D-1");
      r.context.verify("S2", "status", res.status, r.context.plan.expect("TC-01.S2.status"));
      r.context.verify(
        "S2",
        "fields.status",
        res.json("status"),
        r.context.plan.expect("TC-01.S2.fields.status"),
      );
    });
    // Rounds at 0, 2, 4 and 6 s; never more than the 6 s of the plan.
    expect(r.sleeps).toEqual([2000, 2000, 2000]);
    expect((await r.finish()).outcome).toBe("failed");
  });
});
