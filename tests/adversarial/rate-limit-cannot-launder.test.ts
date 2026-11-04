// Adversarial suite: a shared environment that keeps answering 429, and a spec that tries to make a rate limit look
// like a result (REQ-EXEC-54, invariant 1). A limited case is BLOCKED, never FAILED or PASSED, and an order is never
// sent twice.
import { PlanSchema, type CaseAttempt } from "@qajitsu/core";
import { createCaseRuntime, createMasker, type ApiRequest, type ApiTransportResponse } from "@qajitsu/steps";
import { computeStatus } from "@qajitsu/verifier";
import { describe, expect, it } from "vitest";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-20",
  version: 1,
  summary: "Orders on a shared environment.",
  cases: [
    {
      id: "TC-01",
      title: "An order is placed",
      type: "api",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      steps: [
        { id: "S1", action: "GET /products", expect: { description: "Listed", status: 200 } },
        { id: "S2", action: "POST /orders", expect: { description: "Created", status: 201 } },
      ],
      evidence: ["response"],
    },
  ],
  open_questions: [],
  out_of_scope: [],
});

const runtimeWith = (reply: () => ApiTransportResponse, budgetMs = 5000) => {
  let t = 0;
  const sent: ApiRequest[] = [];
  const runtime = createCaseRuntime({
    plan,
    caseId: "TC-01",
    attempt: 1,
    baseUrl: "http://127.0.0.1:3000",
    transport: (req) => {
      sent.push(req);
      return Promise.resolve(reply());
    },
    masker: createMasker(),
    allowedOrigins: ["http://127.0.0.1:3000"],
    accounts: {},
    now: () => t,
    sleep: (ms) => {
      t += ms;
      return Promise.resolve();
    },
    traffic: {
      throttle: () => Promise.resolve(),
      retryBudgetMs: budgetMs,
      idempotencyHeader: "Idempotency-Key",
    },
  });
  return { runtime, sent };
};

const statusOf = (attempt: CaseAttempt) =>
  computeStatus({ caseId: "TC-01", attempts: [attempt] }, { evidenceComplete: true });

describe("a rate limit never becomes a result (REQ-EXEC-54/AC3, invariant 1)", () => {
  it("REQ-EXEC-54/AC3: an environment that answers 429 forever makes the case BLOCKED, not FAILED", async () => {
    const { runtime, sent } = runtimeWith(() => ({ status: 429, headers: { "retry-after": "2" }, text: "" }));
    let record;
    try {
      await runtime.context.step("S1", async () => {
        const res = await runtime.context.api.get("/products");
        runtime.context.verify("S1", "status", res.status, runtime.context.plan.expect("TC-01.S1.status"));
      });
      record = await runtime.finish();
    } catch (error) {
      record = await runtime.finish(error);
    }
    expect(record.outcome).toBe("error");
    expect(record.error).toMatch(/^rate limited/);
    expect(statusOf(record)).toBe("BLOCKED");
    // The budget of 5 s allows two waits of 2 s: three requests in all, then it stops.
    expect(sent).toHaveLength(3);
  });

  it("REQ-EXEC-54/AC2+AC3: a spec that swallows the rate limit cannot turn it into PASSED", async () => {
    const { runtime, sent } = runtimeWith(() => ({ status: 429, headers: { "retry-after": "1" }, text: "" }));
    let record;
    try {
      await runtime.context.step("S2", async () => {
        try {
          await runtime.context.api.post("/orders", { sku: "A" });
        } catch {
          // A lying spec hides the error and claims the plan's status.
        }
        runtime.context.verify("S2", "status", 201, runtime.context.plan.expect("TC-01.S2.status"));
      });
      record = await runtime.finish();
    } catch (error) {
      record = await runtime.finish(error);
    }
    // The order went out once: a POST without an idempotency key is never repeated.
    expect(sent).toHaveLength(1);
    expect(statusOf(record)).not.toBe("PASSED");
  });
});
