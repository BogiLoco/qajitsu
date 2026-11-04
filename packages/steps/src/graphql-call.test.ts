import { PlanSchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createMasker } from "./masking.js";
import { createCaseRuntime, type ApiRequest } from "./runtime.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-18",
  version: 1,
  summary: "GraphQL.",
  cases: [
    {
      id: "TC-01",
      title: "A product is read",
      type: "api",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      steps: [
        {
          id: "S1",
          action: "POST /graphql",
          graphql: { operation: "Query.product" },
          expect: { description: "Read", status: 200, fields: { "data.product.price": 24.99 } },
        },
      ],
      evidence: ["request", "response"],
    },
  ],
  open_questions: [],
  out_of_scope: [],
});

const setup = () => {
  const sent: ApiRequest[] = [];
  const runtime = createCaseRuntime({
    plan,
    caseId: "TC-01",
    attempt: 1,
    baseUrl: "http://127.0.0.1:3000",
    transport: (req) => {
      sent.push(req);
      return Promise.resolve({
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({ data: { product: { price: 24.99 } } }),
      });
    },
    masker: createMasker(),
    allowedOrigins: ["http://127.0.0.1:3000"],
    accounts: {},
    now: () => 0,
  });
  return { runtime, sent };
};

describe("GraphQL calls (REQ-EXEC-48/AC2+AC4)", () => {
  it("REQ-EXEC-48/AC2+AC4: a query with variables is a POST to /graphql; answers are read by path; the call is marked", async () => {
    const { runtime, sent } = setup();
    await runtime.context.step("S1", async () => {
      const res = await runtime.context.api.graphql("query R($id: ID!) { product(id: $id) { price } }", {
        id: "P-2",
      });
      runtime.context.verify(
        "S1",
        "fields.data.product.price",
        res.json("data.product.price"),
        runtime.context.plan.expect("TC-01.S1.fields.data.product.price"),
      );
    });
    const record = await runtime.finish();
    expect(record.outcome).toBe("passed");
    expect(sent[0]).toMatchObject({
      method: "POST",
      url: "http://127.0.0.1:3000/graphql",
      body: { query: "query R($id: ID!) { product(id: $id) { price } }", variables: { id: "P-2" } },
    });
    const call = JSON.parse(String(record.evidence.find((e) => e.name === "S1-01.json")?.content)) as {
      graphql?: boolean;
      request: { body: unknown };
    };
    expect(call.graphql).toBe(true);
    expect(call.request.body).toEqual({
      query: "query R($id: ID!) { product(id: $id) { price } }",
      variables: { id: "P-2" },
    });
  });

  it("REQ-EXEC-48/AC2: another endpoint path is allowed; a query that is not a string is refused", async () => {
    const { runtime, sent } = setup();
    await runtime.context.step("S1", async () => {
      await runtime.context.api.graphql("{ products { id } }", undefined, { path: "/api/graphql" });
      await expect(runtime.context.api.graphql(42 as unknown as string)).rejects.toThrow(
        /query must be a string/,
      );
      await expect(
        runtime.context.api.graphql("{ a }", [1] as unknown as Record<string, unknown>),
      ).rejects.toThrow(/variables an object/);
    });
    expect(sent.map((s) => s.url)).toEqual(["http://127.0.0.1:3000/api/graphql"]);
    expect(sent[0]?.body).toEqual({ query: "{ products { id } }" });
  });
});
