import { PlanSchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createMasker } from "./masking.js";
import { createCaseRuntime, type ApiRequest, type ApiTransportResponse } from "./runtime.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-20",
  version: 1,
  summary: "Orders on a shared environment.",
  cases: [
    {
      id: "TC-01",
      title: "An order is placed on a busy environment",
      type: "api",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      steps: [
        { id: "S1", action: "GET /products", expect: { description: "Listed", status: 200 } },
        {
          id: "S2",
          action: "POST /orders",
          idempotency_key: true,
          expect: { description: "Created", status: 201 },
        },
        { id: "S3", action: "POST /cart", expect: { description: "Added", status: 201 } },
        { id: "S4", action: "GET /limits", expect: { description: "Limited on purpose", status: 429 } },
      ],
      evidence: ["request", "response"],
    },
  ],
  open_questions: [],
  out_of_scope: [],
});

type Reply = ApiTransportResponse | Error;
const limited = (retryAfter = "2"): Reply => ({
  status: 429,
  headers: { "retry-after": retryAfter },
  text: "{}",
});
const ok = (status: number): Reply => ({
  status,
  headers: { "content-type": "application/json" },
  text: "{}",
});

/** A shared environment that answers from a script; a fake clock that only sleeping moves. */
const setup = (replies: Reply[], budgetMs = 10_000) => {
  let t = 0;
  const sent: ApiRequest[] = [];
  const slept: number[] = [];
  const throttled: string[] = [];
  const runtime = createCaseRuntime({
    plan,
    caseId: "TC-01",
    attempt: 2,
    baseUrl: "http://127.0.0.1:3000",
    transport: (req) => {
      sent.push(req);
      const next = replies.shift() ?? ok(200);
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    masker: createMasker(),
    allowedOrigins: ["http://127.0.0.1:3000"],
    accounts: {},
    now: () => t,
    sleep: (ms) => {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
    traffic: {
      throttle: (url) => {
        throttled.push(url);
        return Promise.resolve();
      },
      retryBudgetMs: budgetMs,
      idempotencyHeader: "Idempotency-Key",
    },
  });
  const run = async (stepId: string, call: () => Promise<{ status: number }>) => {
    try {
      await runtime.context.step(stepId, async () => {
        const res = await call();
        runtime.context.verify(
          stepId,
          "status",
          res.status,
          runtime.context.plan.expect(`TC-01.${stepId}.status`),
        );
      });
      return await runtime.finish();
    } catch (error) {
      return runtime.finish(error);
    }
  };
  return { runtime, sent, slept, throttled, run, api: runtime.context.api };
};

const callRecords = async (record: { evidence: readonly { content?: unknown; name: string }[] }) =>
  Promise.resolve(
    record.evidence
      .filter((e) => /^S\d-\d+\.json$/.test(e.name))
      .map(
        (e) =>
          JSON.parse(String(e.content)) as {
            retries?: unknown[];
            request: { headers: Record<string, string> };
          },
      ),
  );

describe("shared environments: rate limits and idempotency (REQ-EXEC-54)", () => {
  it("REQ-EXEC-54/AC1: every request waits for the run's rate first", async () => {
    const r = setup([ok(200)]);
    await r.run("S1", () => r.api.get("/products"));
    expect(r.throttled).toEqual(["http://127.0.0.1:3000/products"]);
  });

  it("REQ-EXEC-54/AC2: a 429 on a safe request is waited out and retried; every retry is evidence", async () => {
    const r = setup([limited("2"), { status: 503, headers: { "Retry-After": "1" }, text: "" }, ok(200)]);
    const record = await r.run("S1", () => r.api.get("/products"));
    expect(record.outcome).toBe("passed");
    expect(r.slept).toEqual([2000, 1000]);
    expect(r.sent).toHaveLength(3);
    const [call] = await callRecords(record);
    expect(call?.retries).toEqual([
      { status: 429, waitedMs: 2000 },
      { status: 503, waitedMs: 1000 },
    ]);
  });

  it("REQ-EXEC-54/AC3: still rate limited after the budget is BLOCKED with the reason, never FAILED", async () => {
    const r = setup([limited("4"), limited("4"), limited("4")], 6000);
    const record = await r.run("S1", () => r.api.get("/products"));
    expect(record.outcome).toBe("error");
    expect(record.error).toMatch(/^rate limited: GET \/products answered 429/);
    expect(record.assertions).toEqual([]);
    expect(r.slept).toEqual([4000]);
  });

  it("REQ-EXEC-54/AC2+AC3: a mutating request without a key is never repeated; a 429 on it is BLOCKED", async () => {
    const r = setup([limited("1"), ok(201)]);
    const record = await r.run("S3", () => r.api.post("/cart", { sku: "A" }));
    expect(r.sent).toHaveLength(1);
    expect(record.outcome).toBe("error");
    expect(record.error).toContain("not safe to repeat");
  });

  it("REQ-EXEC-54/AC4: a step's idempotency key is the same on every retry, also after a timeout", async () => {
    const r = setup([new Error("Timeout 5000ms exceeded"), limited("1"), ok(201)]);
    const record = await r.run("S2", () => r.api.post("/orders", { sku: "A" }));
    expect(record.outcome).toBe("passed");
    const keys = r.sent.map((s) => s.headers["Idempotency-Key"]);
    expect(keys).toEqual(["qj-TC-01-S2-a2-1", "qj-TC-01-S2-a2-1", "qj-TC-01-S2-a2-1"]);
    const [call] = await callRecords(record);
    expect(call?.retries).toEqual([
      { error: "Timeout 5000ms exceeded", waitedMs: 0 },
      { status: 429, waitedMs: 1000 },
    ]);
  });

  it("REQ-EXEC-54/AC2: a timeout of a request without a key is an error, not retried", async () => {
    const r = setup([new Error("Timeout 5000ms exceeded"), ok(201)]);
    const record = await r.run("S3", () => r.api.post("/cart", {}));
    expect(r.sent).toHaveLength(1);
    expect(record.outcome).toBe("error");
  });

  it("REQ-EXEC-54/AC3: a step that expects the limit gets the 429 as it came, without waiting", async () => {
    const r = setup([limited("30")]);
    const record = await r.run("S4", () => r.api.get("/limits"));
    expect(record.outcome).toBe("passed");
    expect(r.slept).toEqual([]);
  });

  it("REQ-EXEC-54/AC2: a 503 without Retry-After is the application's answer, not a rate limit", async () => {
    const r = setup([{ status: 503, headers: {}, text: "" }]);
    const record = await r.run("S1", () => r.api.get("/products"));
    expect(record.outcome).toBe("failed");
    expect(r.sent).toHaveLength(1);
  });
});
