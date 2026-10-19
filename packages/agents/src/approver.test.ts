import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createEventLog, PlanSchema, parseProjectConfig, type RunWorkspace } from "@qajitsu/core";
import type { ResolvedModel } from "@qajitsu/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promptOf, scriptedModel } from "../../../tests/support/mock-model.js";
import { createFetchedRun } from "../../../tests/support/run-fixture.js";
import { runPlanApprover } from "./approver.js";
import { buildChangeContext } from "./context.js";
import type { AgentStageDeps } from "./roles-run.js";
import { createUsageTracker } from "./usage.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-1",
  version: 1,
  ...JSON.parse(readFileSync(new URL("../../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8")),
});

describe("model approver of a plan (REQ-PLAN-10)", () => {
  let root: string;
  let ws: RunWorkspace;
  beforeEach(async () => {
    ({ root, ws } = await createFetchedRun());
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const deps = (planner: ResolvedModel, approver: ResolvedModel): AgentStageDeps => {
    parseProjectConfig({ project: "demo", jira: { type: "file", tickets_dir: "t", project_key: "DEMO" } });
    const events = createEventLog({
      ticket: "DEMO-1",
      run: ws.runId,
      write: () => undefined,
      now: () => new Date(0),
      mask: (v) => v,
    });
    return {
      ws,
      models: {
        forRole: () => Promise.resolve(planner),
        resolve: (ref) =>
          ref === "local/qwen3:14b" ? Promise.resolve(approver) : Promise.reject(new Error(`unknown ${ref}`)),
      },
      events,
      usage: createUsageTracker({ events }),
      now: () => new Date(0),
      maskJson: (v) => v,
      maskText: (t) => t,
    };
  };
  const named = <T extends ResolvedModel>(m: T, id: string): T => ({ ...m, id });

  it("REQ-PLAN-10/AC2+AC3: another model checks the plan; its validated answer comes with the hashes of prompt and answer", async () => {
    const approver = named(
      scriptedModel([
        { text: JSON.stringify({ decision: "revise" }) },
        {
          text: JSON.stringify({
            decision: "approve",
            reasons: ["every criterion has a case with exact values"],
          }),
        },
      ]),
      "local/qwen3:14b",
    );
    const planner = named(scriptedModel([]), "local/gemma4:e2b");
    const decision = await runPlanApprover(deps(planner, approver), {
      plan,
      context: await buildChangeContext(ws),
      flags: [],
      modelRef: "local/qwen3:14b",
    });
    expect(decision).toMatchObject({
      decision: "approve",
      reasons: ["every criterion has a case with exact values"],
      decidedBy: "model",
      model: "local/qwen3:14b",
    });
    expect(decision.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(decision.answerSha256).toMatch(/^[0-9a-f]{64}$/);
    // A decision other than approve needs reasons: the first answer was sent back.
    expect(promptOf(approver, 1)).toContain("revise and handover need at least one reason");
    // The plan is data to check, never instructions.
    expect(promptOf(approver, 0)).toContain('<untrusted_data source=\\"plan\\">');
  });

  it("REQ-PLAN-10/AC2: code decides first: a plan with flagged expectations or open questions goes to a person without asking the model", async () => {
    const approver = named(
      scriptedModel([{ text: JSON.stringify({ decision: "approve", reasons: [] }) }]),
      "local/qwen3:14b",
    );
    const planner = named(scriptedModel([]), "local/gemma4:e2b");
    const context = await buildChangeContext(ws);
    const flagged = await runPlanApprover(deps(planner, approver), {
      plan,
      context,
      flags: ["TC-01 S1 fields.total: looks like a placeholder"],
      modelRef: "local/qwen3:14b",
    });
    expect(flagged).toEqual({
      decision: "handover",
      reasons: ["code flagged 1 expectation(s): TC-01 S1 fields.total: looks like a placeholder"],
      decidedBy: "code",
      model: "code",
    });
    const asked = await runPlanApprover(deps(planner, approver), {
      plan: { ...plan, open_questions: [{ id: "Q1", question: "Which rounding mode applies?" }] },
      context,
      flags: [],
      modelRef: "local/qwen3:14b",
    });
    expect(asked.reasons).toEqual(["the plan has 1 open question(s): Q1 Which rounding mode applies?"]);
    expect(approver.mock.doGenerateCalls).toHaveLength(0);
  });

  it("REQ-PLAN-10/AC2: the approver must be another model than the planner", async () => {
    const same = named(scriptedModel([]), "local/qwen3:14b");
    await expect(
      runPlanApprover(deps(same, same), {
        plan,
        context: await buildChangeContext(ws),
        flags: [],
        modelRef: "local/qwen3:14b",
      }),
    ).rejects.toThrow("The plan approver must be another model than the planner (both are local/qwen3:14b).");
  });
});
