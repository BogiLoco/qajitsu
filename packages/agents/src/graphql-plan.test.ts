import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createEventLog, type RunWorkspace } from "@qajitsu/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promptOf, scriptedModel } from "../../../tests/support/mock-model.js";
import { createFetchedRun } from "../../../tests/support/run-fixture.js";
import { AUTHOR_SYSTEM } from "./author.js";
import { buildChangeContext } from "./context.js";
import { PLANNER_SYSTEM } from "./prompts.js";
import { runPlanner, type AgentStageDeps } from "./roles-run.js";
import { createUsageTracker } from "./usage.js";

const draft = JSON.parse(
  readFileSync(new URL("../../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8"),
) as { cases: { steps: Record<string, unknown>[] }[] };
const withOperation = (operation: string) =>
  JSON.stringify({
    ...draft,
    cases: draft.cases.map((c, i) =>
      i === 0 ? { ...c, steps: c.steps.map((s, j) => (j === 0 ? { ...s, graphql: { operation } } : s)) } : c,
    ),
  });

describe("planning GraphQL cases (REQ-EXEC-48/AC1)", () => {
  let root: string;
  let ws: RunWorkspace;
  beforeEach(async () => {
    ({ root, ws } = await createFetchedRun());
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const deps = (planner: ReturnType<typeof scriptedModel>): AgentStageDeps => {
    const events = createEventLog({
      ticket: "DEMO-1",
      run: ws.runId,
      write: () => undefined,
      now: () => new Date(0),
      mask: (v) => v,
    });
    return {
      ws,
      models: { forRole: () => Promise.resolve(planner), resolve: () => Promise.reject(new Error("unused")) },
      events,
      usage: createUsageTracker({ events }),
      now: () => new Date(0),
      maskJson: (v) => v,
      maskText: (t) => t,
    };
  };

  it("REQ-EXEC-48/AC1: the planner sees the schema's operations; an operation the schema lacks goes back to it", async () => {
    const planner = scriptedModel([
      { text: withOperation("Query.order") },
      { text: withOperation("Query.product") },
    ]);
    const context = {
      ...(await buildChangeContext(ws)),
      graphql: {
        operations: ["Query.product(id: ID!): Product", "Query.products: [Product!]!"],
        source: "shop/api/schema.graphql",
      },
    };
    const plan = await runPlanner(deps(planner), context, {
      summary: "Products.",
      change_type: ["api"],
      endpoints: [],
      screens: [],
      risks: [],
      confidence: "high",
      open_questions: [],
    });
    expect(plan.cases[0]?.steps[0]?.graphql).toEqual({ operation: "Query.product" });
    expect(promptOf(planner, 0)).toContain(
      "## GraphQL operations (shop/api/schema.graphql)\\nQuery.product(id: ID!): Product",
    );
    expect(promptOf(planner, 1)).toContain("TC-01.S1: Query.order is not an operation of the GraphQL schema");
  });

  it("REQ-EXEC-48/AC2: the planner and the author are told how GraphQL steps work", () => {
    expect(PLANNER_SYSTEM).toContain('"graphql": {"operation": "Query.product"}');
    expect(AUTHOR_SYSTEM).toContain('client.graphql("<query naming the plan\'s operation>"');
    expect(PLANNER_SYSTEM).toContain('{"0.data.priceChanged.price": 24.99, "count": 2}');
    expect(AUTHOR_SYSTEM).toContain('client.subscribe("<subscription query>"');
  });
});
