import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CaseResultFileSchema,
  PlanSchema,
  createEventLog,
  fileSpendLedger,
  parseProjectConfig,
} from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedModel } from "../../../tests/support/mock-model.js";
import { createFetchedRun } from "../../../tests/support/run-fixture.js";
import { runAuditor } from "./auditor.js";
import { healSpec } from "./healer.js";
import type { AgentStageDeps } from "./roles-run.js";
import { isScopeBudgetStop, createUsageTracker } from "./usage.js";

const V = "d".repeat(64);
const priced = {
  tools: true,
  structuredOutput: true,
  vision: true,
  contextWindow: 200_000,
  costPerMTok: { input: 2, output: 10 },
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

/** A stage whose ticket already spent its whole budget. */
const stoppedStage = async (ticket: string) => {
  const { root, ws } = await createFetchedRun();
  roots.push(root);
  const ledger = fileSpendLedger(join(root, "budget", "spend.jsonl"));
  await ledger.append({
    kind: "model",
    ts: "2026-11-18T09:00:00.000Z",
    project: "demo-shop",
    ticket,
    ticketVersion: V,
    runId: "earlier",
    stage: "run",
    role: "author",
    model: "mock/scripted",
    caseIds: [],
    inputTokens: 1000,
    cachedInputTokens: 0,
    outputTokens: 0,
    costUsd: 1,
  });
  const model = { ...scriptedModel([{ text: "{}" }]), profile: priced };
  const events = createEventLog({
    ticket,
    run: ws.runId,
    write: () => undefined,
    now: () => new Date(0),
    mask: (v) => v,
  });
  const budget = parseProjectConfig({
    project: "demo-shop",
    jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
    environments: { allowlist: ["http://localhost:3000"] },
    budget: { ticket: { max_tokens: 1000 } },
  }).budget;
  const deps: AgentStageDeps = {
    ws,
    models: { forRole: () => Promise.resolve(model), resolve: () => Promise.resolve(model) },
    events,
    usage: createUsageTracker({
      events,
      now: () => new Date("2026-11-18T10:00:00Z"),
      spend: { ledger, project: "demo-shop", ticket, ticketVersion: V, runId: ws.runId, budget },
    }),
    now: () => new Date(0),
    maskJson: (v) => v,
    maskText: (t) => t,
  };
  return { deps, model, ws };
};

describe("model stages under a stopped ticket budget (REQ-FLOW-06/AC6)", () => {
  it("REQ-FLOW-06/AC6: the healer sends nothing, so a failing case is not healed and stays FAILED", async () => {
    const { deps, model, ws } = await stoppedStage("DEMO-5");
    const plan = PlanSchema.parse({
      schema: 1,
      ticket: "DEMO-5",
      version: 1,
      ...JSON.parse(
        readFileSync(new URL("../../../fixtures/plans/demo-5-draft.json", import.meta.url), "utf8"),
      ),
    });
    await mkdir(ws.path("specs"), { recursive: true });
    const specFile = ws.path("specs", "TC-01.spec.ts");
    await writeFile(
      specFile,
      readFileSync(new URL("../../../fixtures/specs/demo-5/TC-01.spec.ts", import.meta.url)),
    );
    const error = await healSpec(deps, plan, {
      caseId: "TC-01",
      specFile,
      error: "timeout",
      attempt: 1,
    }).catch((e: unknown) => e);
    expect(isScopeBudgetStop(error)).toBe(true);
    expect(model.mock.doGenerateCalls).toHaveLength(0);
  });

  it("REQ-FLOW-06/AC6 + INV-5: the auditor sends nothing; the stop is an audit failure, never a verdict", async () => {
    const { deps, model } = await stoppedStage("DEMO-1");
    const plan = PlanSchema.parse({
      schema: 1,
      ticket: "DEMO-1",
      version: 1,
      ...JSON.parse(
        readFileSync(new URL("../../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8"),
      ),
    });
    const result = CaseResultFileSchema.parse({
      schema: 1,
      caseId: "TC-01",
      runner: "api",
      attempts: [
        { attempt: 1, outcome: "passed", steps: [{ id: "S1", ok: true }], assertions: [], evidence: [] },
      ],
    });
    const error = await runAuditor(deps, {
      plan,
      cases: [{ caseId: "TC-01", status: "PASSED", result, evidence: [] }],
      texts: {},
      images: [],
    }).catch((e: unknown) => e);
    expect(isScopeBudgetStop(error)).toBe(true);
    expect((error as Error).message).toContain("ticket budget reached: 1000 of 1000 tokens");
    expect(model.mock.doGenerateCalls).toHaveLength(0);
  });
});
