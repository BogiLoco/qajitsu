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
) as { cases: Record<string, unknown>[] };
const withData = (kind: string) =>
  JSON.stringify({
    ...draft,
    cases: draft.cases.map((c, i) =>
      i === 0 ? { ...c, test_data: [{ name: "lamp", kind, with: { stock: 3 } }] } : c,
    ),
  });

describe("planning test data (REQ-EXEC-53/AC1)", () => {
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

  it("REQ-EXEC-53/AC1: the planner sees the project's kinds; a kind code cannot create goes back to it", async () => {
    const planner = scriptedModel([{ text: withData("coupon") }, { text: withData("product") }]);
    const context = { ...(await buildChangeContext(ws)), testData: { kinds: ["product"], hook: false } };
    const plan = await runPlanner(deps(planner), context, {
      summary: "Cart.",
      change_type: ["api"],
      endpoints: [],
      screens: [],
      risks: [],
      confidence: "high",
      open_questions: [],
    });
    expect(plan.cases[0]?.test_data).toEqual([{ name: "lamp", kind: "product", with: { stock: 3 } }]);
    expect(promptOf(planner, 0)).toContain("## Test data kinds\\nproduct");
    expect(promptOf(planner, 1)).toContain(
      "TC-01.test_data lamp: kind coupon cannot be created (the project's kinds: product)",
    );
  });

  it("REQ-EXEC-53/AC1: the planner and the author are told how test data works", () => {
    expect(PLANNER_SYSTEM).toContain(
      '"test_data": [{"name": "lamp", "kind": "product", "with": {"stock": 3}}]',
    );
    expect(AUTHOR_SYSTEM).toContain('const lamp = data.get("lamp")');
    expect(AUTHOR_SYSTEM).toContain("never hard-code an id");
  });
});
