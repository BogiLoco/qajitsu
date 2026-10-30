import { PlanSchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createMasker } from "./masking.js";
import { createCaseRuntime, type ApiRequest } from "./runtime.js";

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
          wait: { timeout_s: 10, interval_s: 2 },
          expect: { description: "Ready within 10 s", fields: { status: "ready" } },
        },
      ],
      evidence: ["response"],
    },
  ],
  open_questions: [],
  out_of_scope: [],
});

/** A document that turns ready after `readyAfter` reads; a fake clock that sleeping moves on. */
const setup = (readyAfter: number) => {
  let t = 0;
  let reads = 0;
  const sent: ApiRequest[] = [];
  const sleeps: number[] = [];
  const runtime = createCaseRuntime({
    plan,
    caseId: "TC-01",
    attempt: 1,
    baseUrl: "http://127.0.0.1:3000",
    transport: (req) => {
      sent.push(req);
      reads += 1;
      return Promise.resolve({
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({ id: "D-1", status: reads > readyAfter ? "ready" : "processing" }),
      });
    },
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
  const check = async (stepId: "S1" | "S2") =>
    runtime.context.step(stepId, async () => {
      const res = await runtime.context.api.get("/documents/D-1");
      if (stepId === "S1")
        runtime.context.verify("S1", "status", res.status, runtime.context.plan.expect("TC-01.S1.status"));
      else
        runtime.context.verify(
          "S2",
          "fields.status",
          res.json("status"),
          runtime.context.plan.expect("TC-01.S2.fields.status"),
        );
    });
  return { ...runtime, sent, sleeps, check };
};

describe("waiting for asynchronous outcomes (REQ-EXEC-46)", () => {
  it("REQ-EXEC-46/AC1+AC2: a step with a planned wait repeats until its checks hold; every round is evidence with its time", async () => {
    // S1 reads once (processing); S2 sees processing twice more, then ready.
    const r = setup(3);
    await r.check("S1");
    await r.check("S2");
    const record = await r.finish();
    expect(record.outcome).toBe("passed");
    expect(r.sleeps).toEqual([2000, 2000]);
    // Only the last round's checks decide; the earlier ones are in the wait evidence.
    expect(record.assertions.filter((a) => a.stepId === "S2")).toEqual([
      { stepId: "S2", field: "fields.status", expected: "ready", actual: "ready", pass: true },
    ]);
    expect(record.steps.find((s) => s.id === "S2")?.wait).toEqual({ waitedMs: 4000, rounds: 3, met: true });
    expect(record.evidence.map((e) => e.name)).toEqual(
      expect.arrayContaining(["S2-01.json", "S2-02.json", "S2-03.json", "S2-wait.json"]),
    );
    const wait = JSON.parse(
      String(record.evidence.find((e) => e.name === "S2-wait.json")?.content),
    ) as unknown;
    expect(wait).toEqual({
      timeout_s: 10,
      interval_s: 2,
      waitedMs: 4000,
      met: true,
      rounds: [
        { atMs: 0, checks: [{ field: "fields.status", actual: "processing", pass: false }] },
        { atMs: 2000, checks: [{ field: "fields.status", actual: "processing", pass: false }] },
        { atMs: 4000, checks: [{ field: "fields.status", actual: "ready", pass: true }] },
      ],
    });
  });

  it("REQ-EXEC-46/AC3: an expectation not met at the timeout fails the step with the last observed value", async () => {
    const r = setup(1_000);
    await r.check("S1");
    await r.check("S2");
    const record = await r.finish();
    expect(record.outcome).toBe("failed");
    expect(record.assertions.filter((a) => a.stepId === "S2")).toEqual([
      { stepId: "S2", field: "fields.status", expected: "ready", actual: "processing", pass: false },
    ]);
    // Rounds at 0, 2, 4, 6, 8 and 10 s: one more would go past the 10 s of the plan.
    expect(record.steps.find((s) => s.id === "S2")?.wait).toEqual({
      waitedMs: 10_000,
      rounds: 6,
      met: false,
    });
    expect(r.sleeps).toHaveLength(5);
  });

  it("REQ-EXEC-46/AC3: polling never goes past the step: a verify() after it ended is refused, and a step without a wait runs once", async () => {
    const r = setup(1_000);
    await r.check("S1");
    expect(r.sleeps).toEqual([]);
    expect(() => {
      r.context.verify("S2", "fields.status", "ready", "ready");
    }).toThrow(/must run inside step/);
    await r.check("S2");
    expect(() => {
      r.context.verify("S2", "fields.status", "ready", "ready");
    }).toThrow(/must run inside step/);
    expect((await r.finish()).outcome).toBe("failed");
  });

  it("REQ-EXEC-46/AC3: an error inside a waiting step ends the attempt at once; it is not retried until it passes", async () => {
    const r = setup(1_000);
    let rounds = 0;
    await expect(
      r.context.step("S2", () => {
        rounds += 1;
        throw new Error("connection refused");
      }),
    ).rejects.toThrow("connection refused");
    expect(rounds).toBe(1);
    expect(r.sleeps).toEqual([]);
    // The error ends the step; the runner ends the attempt as an error (the spec's run() rejects).
    expect((await r.finish()).steps).toEqual([{ id: "S2", ok: false, error: "connection refused" }]);
  });

  it("REQ-EXEC-46/AC3: a waiting step that checks nothing fails at the timeout; it never counts as met", async () => {
    const r = setup(0);
    await r.context.step("S2", async () => {
      await r.context.api.get("/documents/D-1");
    });
    const record = await r.finish();
    expect(record.outcome).toBe("failed");
    expect(record.assertions).toEqual([
      expect.objectContaining({ field: "wait", actual: "the last round checked nothing", pass: false }),
    ]);
  });
});
