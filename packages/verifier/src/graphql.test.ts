import { ConfigError, PlanSchema, type AttemptRecord, type EvidenceItem } from "@qajitsu/core";
import { buildSchema, graphqlSync, getIntrospectionQuery } from "graphql";
import { describe, expect, it } from "vitest";
import { buildGraphqlSchema, checkGraphqlAttempt, graphqlOperations } from "./graphql.js";

const SDL = `
type Query { product(id: ID!): Product  products: [Product!]! }
type Mutation { addToCart(sku: String!, qty: Int!): Cart! }
type Product { id: ID!  name: String!  price: Float!  stock: Int!  status: Status!  tags: [String!] }
enum Status { ACTIVE ARCHIVED }
type Cart { items: [CartItem!]!  total: Float! }
type CartItem { sku: String!  qty: Int! }
`;
const schema = buildGraphqlSchema(SDL);

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-30",
  version: 1,
  summary: "Products over GraphQL.",
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
          expect: { description: "Read", status: 200, fields: { "data.product.price": 12.5 } },
        },
        {
          id: "S2",
          action: "POST /graphql",
          graphql: { operation: "Mutation.addToCart" },
          expect: { description: "Refused", status: 200, fields: { "errors.0.message": "Out of stock" } },
        },
      ],
      evidence: ["request", "response"],
    },
  ],
  open_questions: [],
  out_of_scope: [],
});

const exchange = (stepId: string, query: string, response: unknown) => ({
  name: `${stepId}-01.json`,
  kind: "response" as const,
  stepId,
  content: JSON.stringify({
    method: "POST",
    url: "http://127.0.0.1:3000/graphql",
    graphql: true,
    request: { headers: {}, body: { query, variables: { id: "P-1" } } },
    response: { status: 200, headers: {}, body: response },
  }),
});

const attempt = (...evidence: EvidenceItem[]): AttemptRecord => ({
  caseId: "TC-01",
  attempt: 1,
  outcome: "passed",
  steps: [...new Set(evidence.map((e) => e.stepId))].map((id) => ({ id, ok: true })),
  assertions: [
    { stepId: "S1", field: "fields.data.product.price", expected: 12.5, actual: 12.5, pass: true },
  ],
  evidence,
});

const READ = "query Read($id: ID!) { product(id: $id) { id name price status tags } }";
const good = { data: { product: { id: "P-1", name: "Lamp", price: 12.5, status: "ACTIVE", tags: null } } };

describe("GraphQL testing (REQ-EXEC-48)", () => {
  it("REQ-EXEC-48/AC1: the schema is read from SDL or introspection, and its operations are listed for the planner", () => {
    expect(graphqlOperations(schema)).toEqual([
      "Query.product(id: ID!): Product",
      "Query.products: [Product!]!",
      "Mutation.addToCart(sku: String!, qty: Int!): Cart!",
    ]);
    const introspection = graphqlSync({ schema: buildSchema(SDL), source: getIntrospectionQuery() });
    expect(graphqlOperations(buildGraphqlSchema(JSON.stringify(introspection)))).toHaveLength(3);
    expect(graphqlOperations(buildGraphqlSchema(JSON.stringify(introspection.data)))).toHaveLength(3);
    expect(() => buildGraphqlSchema("type Query {")).toThrow(ConfigError);
    expect(() => buildGraphqlSchema('{"nothing": 1}')).toThrow(/GraphQL/);
  });

  it("REQ-EXEC-48/AC3: a response that fits the schema and the plan changes nothing", () => {
    const record = attempt(exchange("S1", READ, good));
    expect(checkGraphqlAttempt(record, plan, schema)).toEqual(record);
  });

  it("REQ-EXEC-48/AC3: errors where the plan expects data fail the step, even with HTTP 200", () => {
    const record = attempt(
      exchange("S1", READ, {
        data: { product: null },
        errors: [{ message: "Internal error", path: ["product"] }],
      }),
    );
    const checked = checkGraphqlAttempt(record, plan, undefined);
    expect(checked.assertions).toContainEqual({
      stepId: "S1",
      field: "graphql.errors",
      expected: "no errors",
      actual: ["Internal error"],
      pass: false,
    });
  });

  it("REQ-EXEC-48/AC3: errors the plan expects are the result, not a failure", () => {
    const record = attempt(
      exchange("S2", 'mutation { addToCart(sku: "A", qty: 9) { total } }', {
        data: null,
        errors: [{ message: "Out of stock" }],
      }),
    );
    expect(checkGraphqlAttempt(record, plan, schema).assertions.map((a) => a.field)).not.toContain(
      "graphql.errors",
    );
  });

  it("REQ-EXEC-48/AC3: data that does not fit the schema of the analysed commit fails the step", () => {
    const record = attempt(
      exchange("S1", READ, {
        data: {
          product: { id: "P-1", name: null, price: "12.50", status: "DELETED", tags: [1], extra: true },
        },
      }),
    );
    const problems = checkGraphqlAttempt(record, plan, schema).assertions.filter(
      (a) => a.field === "graphql.schema",
    );
    expect(problems.map((a) => a.actual)).toEqual([
      "data.product.name is null, the schema says String!",
      "data.product.price is a string, the schema says Float!",
      "data.product.status is DELETED, not a value of Status",
      "data.product.tags.0 is a number, the schema says String!",
      "data.product.extra was not asked for",
    ]);
    expect(problems.every((a) => !a.pass && a.stepId === "S1")).toBe(true);
  });

  it("REQ-EXEC-48/AC3: aliases, fragments and __typename are read like the server reads them", () => {
    const query =
      'query { first: product(id: "P-1") { ...Main __typename } products { ... on Product { id } } } fragment Main on Product { id price }';
    const record = attempt(
      exchange("S1", query, {
        data: { first: { id: "P-1", price: 1, __typename: "Product" }, products: [{ id: "P-2" }] },
      }),
    );
    expect(checkGraphqlAttempt(record, plan, schema).assertions).toEqual(record.assertions);
  });

  it("REQ-EXEC-48/AC2: a query that does not fit the schema, or skips the planned operation, is the spec's error: BLOCKED", () => {
    const unknown = checkGraphqlAttempt(
      attempt(exchange("S1", "{ product(id: 1) { colour } }", good)),
      plan,
      schema,
    );
    expect(unknown.outcome).toBe("error");
    expect(unknown.error).toContain(
      'S1: the GraphQL query does not fit the schema: Cannot query field "colour"',
    );
    const syntax = checkGraphqlAttempt(attempt(exchange("S1", "{ product(", good)), plan, undefined);
    expect(syntax.outcome).toBe("error");
    expect(syntax.error).toContain("S1: the GraphQL query cannot be parsed");
    const other = checkGraphqlAttempt(
      attempt(exchange("S1", "{ products { id } }", { data: { products: [] } })),
      plan,
      schema,
    );
    expect(other.error).toContain(
      "S1: the plan's operation is Query.product, the query asks for Query.products",
    );
  });

  it("REQ-EXEC-48: calls that are not GraphQL, and unreadable evidence, are left alone", () => {
    const rest = {
      name: "S1-01.json",
      kind: "response" as const,
      stepId: "S1",
      content: JSON.stringify({ method: "GET", url: "x", response: { status: 200, body: {} } }),
    };
    const broken = { name: "S1-02.json", kind: "response" as const, stepId: "S1", content: "{" };
    const bytes = {
      name: "S1-03.json",
      kind: "response" as const,
      stepId: "S1",
      content: new Uint8Array([1]),
    };
    const record = attempt(rest, broken, bytes, exchange("S1", READ, good));
    expect(checkGraphqlAttempt(record, plan, schema)).toEqual(record);
  });

  it("REQ-EXEC-48/AC2+AC3: a step planned as GraphQL that posts its query as plain JSON is the spec's error: BLOCKED", () => {
    const plain = {
      name: "S1-01.json",
      kind: "response" as const,
      stepId: "S1",
      content: JSON.stringify({
        method: "POST",
        url: "http://127.0.0.1:3000/graphql",
        request: { body: { query: READ } },
        response: { status: 200, body: { data: null, errors: [{ message: "boom" }] } },
      }),
    };
    const dodged = checkGraphqlAttempt(attempt(plain), plan, schema);
    expect(dodged.outcome).toBe("error");
    expect(dodged.error).toBe(
      "S1: the plan's GraphQL operation Query.product was not called with api.graphql() or api.subscribe()",
    );
  });

  it("REQ-EXEC-48/AC3: every kind of type, root and error entry is read the way the schema says", () => {
    const wide = buildGraphqlSchema(`
      type Query { item: Item  count: Int!  flag: Boolean!  ids: [ID!]!  when: Date  node: Item!  product: Product }
      type Mutation { save(n: Int!): Item! }
      type Subscription { ticks: Int! }
      scalar Date
      type Item { id: ID!  n: Int! }
      enum Status { ACTIVE }
      type Product { status: Status! }
    `);
    const loose = PlanSchema.parse({
      ...plan,
      cases: [
        {
          ...plan.cases[0],
          steps: [{ id: "S1", action: "POST /graphql", expect: { description: "Any", status: 200 } }],
        },
      ],
    });
    const run = (query: string, body: unknown) =>
      checkGraphqlAttempt(attempt(exchange("S1", query, body)), loose, wide)
        .assertions.filter((a) => a.field !== "fields.data.product.price")
        .map((a) => a.actual);
    expect(
      run("{ item { id n __typename } count flag ids when node { id } }", {
        data: {
          item: { id: 5, n: 1.5, __typename: 3 },
          count: "x",
          flag: 1,
          ids: "a",
          when: "2026",
          node: 7,
        },
      }),
    ).toEqual([
      "data.item.n is a number, the schema says Int!",
      "data.item.__typename is a number, the schema says String!",
      "data.count is a string, the schema says Int!",
      "data.flag is a number, the schema says Boolean!",
      "data.ids is a string, the schema says [ID!]!",
      "data.node is a number, the schema says Item!",
    ]);
    expect(run("{ product { status } }", { data: { product: { status: 5 } } })).toEqual([
      "data.product.status is 5, not a value of Status",
    ]);
    expect(run("mutation { save(n: 1) { id } }", { data: { save: { id: "1", n: 2 } } })).toEqual([
      "data.save.n was not asked for",
    ]);
    expect(run("subscription { ticks }", { data: { ticks: 1 } })).toEqual([]);
    expect(run("{ count }", { data: null, errors: ["boom"] })).toEqual([["boom"]]);
    expect(run("{ count }", "not json")).toEqual([]);
  });

  it("REQ-EXEC-48/AC2: a query that asks for its planned operation only through a fragment is not the plan's", () => {
    const viaFragment = checkGraphqlAttempt(
      attempt(exchange("S1", "{ ...Q } fragment Q on Query { products { id } }", { data: { products: [] } })),
      plan,
      schema,
    );
    expect(viaFragment.error).toContain(
      "S1: the plan's operation is Query.product, the query asks for nothing",
    );
    const errored = {
      ...attempt(exchange("S1", READ, { data: null, errors: [{ message: "down" }] })),
      outcome: "error" as const,
    };
    expect(checkGraphqlAttempt(errored, plan, schema).outcome).toBe("error");
  });

  it("REQ-EXEC-48/AC2+AC3: a subscription's query and every payload are checked like a query's", () => {
    const subSchema = buildGraphqlSchema(`${SDL}\ntype Subscription { priceChanged(id: ID!): Product! }`);
    const subPlan = PlanSchema.parse({
      ...plan,
      cases: [
        {
          ...plan.cases[0],
          steps: [
            {
              id: "S1",
              action: "WS /graphql",
              graphql: { operation: "Subscription.priceChanged" },
              expect: { description: "Prices", messages: { "0.data.priceChanged.price": 12.5 } },
            },
          ],
        },
      ],
    });
    const stream = (query: string, frames: readonly { dir: string; data: string }[]): EvidenceItem => ({
      name: "S1-websocket-01.json",
      kind: "log",
      stepId: "S1",
      content: JSON.stringify({
        kind: "websocket",
        url: "ws://x/graphql",
        graphql: true,
        request: { body: { query } },
        frames,
      }),
    });
    const next = (price: unknown) => ({
      dir: "received",
      data: JSON.stringify({
        id: "1",
        type: "next",
        payload: { data: { priceChanged: { id: "P-1", price } } },
      }),
    });
    const SUB = 'subscription { priceChanged(id: "P-1") { id price } }';
    const good = attempt(stream(SUB, [{ dir: "sent", data: "{}" }, next(12.5), next(11)]));
    expect(checkGraphqlAttempt(good, subPlan, subSchema)).toEqual(good);
    const text = checkGraphqlAttempt(attempt(stream(SUB, [next(12.5), next("11.00")])), subPlan, subSchema);
    expect(text.assertions.filter((a) => a.field === "graphql.schema").map((a) => a.actual)).toEqual([
      "data.priceChanged.price is a string, the schema says Float!",
    ]);
    const failed = checkGraphqlAttempt(
      attempt(
        stream(SUB, [
          { dir: "received", data: JSON.stringify({ type: "error", payload: [{ message: "down" }] }) },
          { dir: "received", data: "garbage" },
        ]),
      ),
      subPlan,
      subSchema,
    );
    expect(failed.assertions.at(-1)).toMatchObject({ field: "graphql.errors", actual: ["down"] });
    const odd = attempt(
      stream(SUB, [
        { dir: "received", data: 5 as unknown as string },
        { dir: "received", data: JSON.stringify({ id: "1", type: "next", payload: null }) },
      ]),
    );
    expect(checkGraphqlAttempt(odd, subPlan, subSchema)).toEqual(odd);
    const elsewhere = { ...attempt(stream(SUB, [next("x")])), caseId: "TC-99" };
    expect(checkGraphqlAttempt(elsewhere, subPlan, undefined)).toEqual(elsewhere);
    const unknown = checkGraphqlAttempt(attempt(stream("subscription { ticks }", [])), subPlan, subSchema);
    expect(unknown.outcome).toBe("error");
    expect(unknown.error).toContain('Cannot query field "ticks" on type "Subscription"');
    const plannedErrors = PlanSchema.parse({
      ...subPlan,
      cases: [
        {
          ...subPlan.cases[0],
          steps: [
            {
              ...subPlan.cases[0]?.steps[0],
              expect: { description: "Refused", messages: { "0.errors.0.message": "down" } },
            },
          ],
        },
      ],
    });
    const refused = attempt(
      stream(SUB, [
        { dir: "received", data: JSON.stringify({ type: "error", payload: [{ message: "down" }] }) },
      ]),
    );
    expect(checkGraphqlAttempt(refused, plannedErrors, subSchema)).toEqual(refused);
  });
});
