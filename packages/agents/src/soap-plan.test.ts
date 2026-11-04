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
      i === 0 ? { ...c, steps: c.steps.map((s, j) => (j === 0 ? { ...s, soap: { operation } } : s)) } : c,
    ),
  });

describe("planning SOAP cases (REQ-EXEC-50/AC1)", () => {
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

  it("REQ-EXEC-50/AC1: the planner sees the WSDL's operations; an operation the WSDL lacks goes back to it", async () => {
    const planner = scriptedModel([{ text: withOperation("GetOrder") }, { text: withOperation("GetPrice") }]);
    const context = {
      ...(await buildChangeContext(ws)),
      soap: { operations: ["GetPrice", "SetPrice"], elements: ["Ping"], source: "shop/api/prices.wsdl" },
    };
    const plan = await runPlanner(deps(planner), context, {
      summary: "Prices.",
      change_type: ["api"],
      endpoints: [],
      screens: [],
      risks: [],
      confidence: "high",
      open_questions: [],
    });
    expect(plan.cases[0]?.steps[0]?.soap).toEqual({ operation: "GetPrice" });
    expect(promptOf(planner, 0)).toContain(
      "## SOAP operations (shop/api/prices.wsdl)\\nGetPrice\\nSetPrice\\nXML elements of the schemas:\\nPing",
    );
    expect(promptOf(planner, 1)).toContain(
      "TC-01.S1: GetOrder is not an operation of the WSDL; use one of GetPrice, SetPrice",
    );
  });

  it("REQ-EXEC-47/AC1+AC2: the planner and the author are told how WebSocket and event stream steps work", () => {
    expect(PLANNER_SYSTEM).toContain('"stream": {"timeout_s": 5}');
    expect(PLANNER_SYSTEM).toContain('{"0.event": "created", "0.data.status": "created"}');
    expect(AUTHOR_SYSTEM).toContain('client.websocket("<path>")');
    expect(AUTHOR_SYSTEM).toContain(
      'verify("<step id>", "messages.<n>.<path>" | "messages.count", undefined',
    );
  });

  it("REQ-EXEC-50/AC1+AC3: the planner and the author are told how SOAP steps and XPath checks work", () => {
    expect(PLANNER_SYSTEM).toContain('"soap": {"operation": "GetPrice"}');
    expect(PLANNER_SYSTEM).toContain('"//GetPriceResponse/amount": 24.99');
    expect(AUTHOR_SYSTEM).toContain('client.soap("<path>"');
    expect(AUTHOR_SYSTEM).toContain('verify("<step id>", "xml.<xpath>", await res.xml("<xpath>")');
  });
});
