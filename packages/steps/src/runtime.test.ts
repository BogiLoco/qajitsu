import { readFileSync } from "node:fs";
import { PlanSchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createMasker } from "./masking.js";
import type { UiDriver } from "./ui.js";
import { createCaseRuntime, createPlanAccessor, type ApiRequest, type ApiTransport } from "./runtime.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-1",
  version: 1,
  ...JSON.parse(readFileSync(new URL("../../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8")),
});
const TOKEN = "session-token-123456";

const setup = (responses: Record<string, { status: number; body: unknown }> = {}) => {
  const sent: ApiRequest[] = [];
  const transport: ApiTransport = (req) => {
    sent.push(req);
    const r = responses[`${req.method} ${new URL(req.url).pathname}`] ?? {
      status: 404,
      body: { error: "NOT_FOUND" },
    };
    return Promise.resolve({
      status: r.status,
      headers: { "set-cookie": "sid=abc" },
      text: typeof r.body === "string" ? r.body : JSON.stringify(r.body),
    });
  };
  let t = 0;
  const masker = createMasker({ secrets: [TOKEN] });
  const runtime = createCaseRuntime({
    plan,
    caseId: "TC-01",
    attempt: 1,
    baseUrl: "http://127.0.0.1:3000",
    transport,
    masker,
    allowedOrigins: ["http://127.0.0.1:3000"],
    accounts: { "user:standard": { authorization: `Bearer ${TOKEN}` } },
    now: () => (t += 5),
  });
  return { ...runtime, sent };
};

describe("plan.expect (REQ-EXEC-02/AC3, invariant 4)", () => {
  const accessor = createPlanAccessor(plan, "TC-01");
  it("reads status, fields, texts and description from the approved plan", () => {
    expect(accessor.expect("TC-01.S1.status")).toBe(200);
    expect(accessor.expect("TC-01.S1.fields.total")).toBe(1.01);
    expect(accessor.expect("TC-01.S1.description")).toBe("Total is 1.01");
  });
  it.each([
    ["TC-02.S1.status", /may only read expectations of TC-01/],
    ["TC-01.S9.status", /no step S9/],
    ["TC-01.S1.fields.missing", /no expected field/],
    ["TC-01.S1.texts.0", /no expected value/],
    ["TC-01.S1.bogus", /unknown field/],
  ])("refuses %s", (path, error) => {
    expect(() => accessor.expect(path)).toThrow(error);
  });
});

describe("case runtime (REQ-EXEC-02, REQ-EVD-01, REQ-CFG-06)", () => {
  it("REQ-EXEC-02/AC1+AC2 + REQ-EVD-01/AC1+AC2: records steps, assertions and one masked JSON with cURL per call", async () => {
    const { context, finish, sent } = setup({
      "GET /cart": { status: 200, body: { total: 1.01, token: TOKEN } },
    });
    await context.step("S1", async () => {
      const res = await context.api.as("user:standard").get("/cart", { query: { verbose: 1 } });
      context.verify("S1", "status", res.status, context.plan.expect("TC-01.S1.status"));
      context.verify("S1", "fields.total", res.json("total"), context.plan.expect("TC-01.S1.fields.total"));
      expect(res.json("missing.path")).toBeUndefined();
    });
    expect(sent[0]?.url).toBe("http://127.0.0.1:3000/cart?verbose=1");
    expect(sent[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    const record = await finish();
    expect(record.outcome).toBe("passed");
    expect(record.steps).toEqual([{ id: "S1", ok: true }]);
    expect(record.assertions).toEqual([
      { stepId: "S1", field: "status", expected: 200, actual: 200, pass: true },
      { stepId: "S1", field: "fields.total", expected: 1.01, actual: 1.01, pass: true },
    ]);
    expect(record.evidence).toHaveLength(1);
    const file = JSON.parse(String(record.evidence[0]!.content)) as Record<string, unknown>;
    expect(record.evidence[0]!.name).toBe("S1-01.json");
    expect(file).toMatchObject({
      method: "GET",
      durationMs: 5,
      response: { status: 200, body: { total: 1.01, token: "***" } },
    });
    expect(file["assertions"]).toHaveLength(2);
    expect(String(file["curl"])).toContain("curl -X GET 'http://127.0.0.1:3000/cart?verbose=1'");
    expect(JSON.stringify(record)).not.toContain(TOKEN);
  });

  it("REQ-EXEC-02/AC4: request bodies, response text and errors are masked", async () => {
    const { context, finish } = setup({ "POST /auth/login": { status: 500, body: `crash ${TOKEN}` } });
    await expect(
      context.step("S1", async () => {
        await context.api.post("/auth/login", { password: "pw-plain", note: TOKEN });
        throw new Error(`boom ${TOKEN}`);
      }),
    ).rejects.toThrow();
    const record = await finish(new Error(`boom ${TOKEN}`));
    expect(record.outcome).toBe("error");
    expect(JSON.stringify(record)).not.toContain(TOKEN);
    expect(JSON.stringify(record)).not.toContain("pw-plain");
  });

  it("REQ-VER-02: a failed assertion makes the attempt failed, even when a later step crashes", async () => {
    const { context, finish } = setup({ "GET /cart": { status: 200, body: { total: 1.02 } } });
    await context.step("S1", async () => {
      const res = await context.api.get("/cart");
      context.verify("S1", "fields.total", res.json("total"), context.plan.expect("TC-01.S1.fields.total"));
    });
    const record = await finish(new Error("later crash"));
    expect(record.outcome).toBe("failed");
    expect(record.error).toBe("later crash");
  });

  it("refuses unknown steps, repeated steps, unknown verify steps, calls outside steps, unknown aliases and foreign origins", async () => {
    const { context } = setup();
    await expect(context.step("S7", () => undefined)).rejects.toThrow(/not a step of TC-01/);
    await context.step("S1", () => undefined);
    await expect(context.step("S1", () => undefined)).rejects.toThrow(/ran twice/);
    expect(() => {
      context.verify("S9", "status", 1, 1);
    }).toThrow(/not a step/);
    await expect(context.api.get("/cart")).rejects.toThrow(/inside step/);
    const second = setup().context;
    await expect(
      second.step("S1", () =>
        second.api
          .as("user:ghost")
          .get("/cart")
          .then(() => undefined),
      ),
    ).rejects.toThrow(/Unknown account alias/);
    const third = setup().context;
    await expect(
      third.step("S1", () => third.api.get("https://attacker.example.org/x").then(() => undefined)),
    ).rejects.toThrow(/allowlist/);
  });

  it("supports every HTTP method and non-JSON bodies", async () => {
    const { context, finish, sent } = setup({
      "PUT /x": { status: 204, body: "" },
      "DELETE /x": { status: 200, body: "plain" },
    });
    await context.step("S1", async () => {
      await context.api.put("/x", { a: 1 });
      await context.api.patch("/x", { a: 2 });
      const del = await context.api.delete("/x");
      expect(del.text).toBe("plain");
      expect(del.json()).toBeUndefined();
    });
    expect(sent.map((r) => r.method)).toEqual(["PUT", "PATCH", "DELETE"]);
    expect((await finish()).evidence.map((e) => e.name)).toEqual(["S1-01.json", "S1-02.json", "S1-03.json"]);
  });

  it("refuses a case that is not in the approved plan", () => {
    expect(() =>
      createCaseRuntime({
        plan,
        caseId: "TC-99",
        attempt: 1,
        baseUrl: "http://x",
        transport: () => Promise.reject(new Error()),
        masker: createMasker(),
        allowedOrigins: [],
        accounts: {},
        now: () => 0,
      }),
    ).toThrow(/not in the approved plan/);
  });

  it("invariants 1 and 4: verify takes actual from the recorded response and expected from the plan", async () => {
    const { context, finish } = setup({ "GET /cart": { status: 200, body: { total: 1.02 } } });
    await context.step("S1", async () => {
      await context.api.get("/cart");
      // A lying spec passes made-up values; they are ignored.
      context.verify("S1", "fields.total", 1.01, 1.01);
      context.verify("S1", "status", 500, 500);
    });
    expect((await finish()).assertions).toEqual([
      { stepId: "S1", field: "fields.total", expected: 1.01, actual: 1.02, pass: false },
      { stepId: "S1", field: "status", expected: 200, actual: 200, pass: true },
    ]);
  });

  it("the verified response must come from the endpoint of the plan step and from inside the step", async () => {
    const health = setup({ "GET /health": { status: 200, body: {} } });
    await expect(
      health.context.step("S1", async () => {
        await health.context.api.get("/health");
        health.context.verify("S1", "status");
      }),
    ).rejects.toThrow(/last response is GET \/health, the plan step is GET \/cart/);
    const empty = setup();
    await expect(
      empty.context.step("S1", () => {
        empty.context.verify("S1", "status");
      }),
    ).rejects.toThrow(/needs a response/);
    const outside = setup();
    expect(() => {
      outside.context.verify("S1", "status");
    }).toThrow(/must run inside step/);
    const unknownField = setup({ "GET /cart": { status: 200, body: {} } });
    await expect(
      unknownField.context.step("S1", async () => {
        await unknownField.context.api.get("/cart");
        unknownField.context.verify("S1", "description");
      }),
    ).rejects.toThrow(/only status, fields/);
  });

  it("account headers cannot be replaced by a spec", async () => {
    const { context, sent } = setup({ "GET /cart": { status: 200, body: {} } });
    await context.step("S1", async () => {
      await context.api.as("user:standard").get("/cart", { headers: { authorization: "Bearer forged" } });
    });
    expect(sent[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("covers texts, non-HTTP actions, direct operations and non-Error failures", async () => {
    const custom = PlanSchema.parse({
      schema: 1,
      ticket: "DEMO-1",
      version: 1,
      cases: [
        {
          id: "TC-05",
          title: "Banner text",
          type: "api",
          priority: "low",
          source: [{ kind: "ac", id: "AC1" }],
          steps: [
            {
              id: "S1",
              action: "Open the banner",
              expect: { description: "d", texts: ["Welcome", "Missing"] },
            },
          ],
          evidence: ["response"],
        },
      ],
    });
    const runtime = createCaseRuntime({
      plan: custom,
      caseId: "TC-05",
      attempt: 1,
      baseUrl: "http://127.0.0.1:3000",
      transport: () => Promise.resolve({ status: 200, headers: {}, text: "<h1>Welcome</h1>" }),
      masker: createMasker(),
      allowedOrigins: ["http://127.0.0.1:3000"],
      accounts: {},
      now: () => 0,
    });
    expect(() => createPlanAccessor(custom, "TC-05").expect("TC-05")).toThrow(/unknown case or step/);
    runtime.beginStep("S1");
    await runtime.call(undefined, "GET", "/banner", undefined, {});
    await expect(runtime.call("user:ghost", "GET", "/banner", undefined, {})).rejects.toThrow(
      /Unknown account alias 'user:ghost'/,
    );
    await runtime.verify("S1", "texts.0");
    await runtime.verify("S1", "texts.1");
    await expect(runtime.endStep("S9")).rejects.toThrow(/was not running/);
    await runtime.endStep("S1");
    expect(await runtime.finish("plain string failure")).toMatchObject({
      outcome: "failed",
      error: "plain string failure",
      assertions: [
        { field: "texts.0", actual: "Welcome", pass: true },
        { field: "texts.1", actual: "(text not found in the response)", pass: false },
      ],
    });
    expect((await setup().finish(42)).error).toBe("non-Error value thrown");
  });

  it("REQ-VER-02: a value missing from the response is recorded as (absent), so the record stays valid JSON", async () => {
    const { context, finish } = setup({ "GET /cart": { status: 200, body: {} } });
    await context.step("S1", async () => {
      await context.api.get("/cart");
      context.verify("S1", "fields.total");
    });
    const record = await finish();
    expect(record.assertions[0]).toEqual({
      stepId: "S1",
      field: "fields.total",
      expected: 1.01,
      actual: "(absent)",
      pass: false,
    });
    expect(JSON.parse(JSON.stringify(record.assertions[0]))).toHaveProperty("actual", "(absent)");
  });

  it("stage-5 review: in a mixed step, texts are read from the source of the step's last action", async () => {
    const custom = PlanSchema.parse({
      schema: 1,
      ticket: "DEMO-5",
      version: 1,
      cases: [
        {
          id: "TC-01",
          title: "mixed",
          type: "web",
          priority: "high",
          source: [{ kind: "ac", id: "AC1" }],
          steps: [
            {
              id: "S1",
              action: "Open page then call API",
              expect: { description: "d", texts: ["Order placed"] },
            },
          ],
          evidence: ["response"],
        },
      ],
    });
    const page = "Order placed";
    const driver = {
      goto: () => Promise.resolve(),
      pageText: () => Promise.resolve(page),
      screenshot: () => Promise.resolve(new Uint8Array()),
      url: () => "http://127.0.0.1:3000/app",
      dom: () => Promise.resolve(""),
    } as unknown as UiDriver;
    const runtime = createCaseRuntime({
      plan: custom,
      caseId: "TC-01",
      attempt: 1,
      baseUrl: "http://127.0.0.1:3000",
      transport: () => Promise.resolve({ status: 200, headers: {}, text: '{"status":"pending"}' }),
      masker: createMasker(),
      allowedOrigins: ["http://127.0.0.1:3000"],
      accounts: {},
      now: () => 0,
      ui: () => Promise.resolve(driver),
    });
    runtime.beginStep("S1");
    await runtime.uiOp({ op: "goto", path: "/app" });
    await runtime.call(undefined, "GET", "/orders/1", undefined, {});
    await runtime.verify("S1", "texts.0");
    expect((await runtime.finish()).assertions[0]).toMatchObject({
      actual: "(text not found in the response)",
      pass: false,
    });
  });
});
