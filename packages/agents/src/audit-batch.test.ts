import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { CaseResultFileSchema, PlanSchema, createEventLog, type RunEvent } from "@qajitsu/core";
import type { BatchAnswer, BatchCall, BatchState, ModelBatch } from "@qajitsu/models";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedModel } from "../../../tests/support/mock-model.js";
import { createFetchedRun } from "../../../tests/support/run-fixture.js";
import { collectAudit, queueAudit } from "./audit-batch.js";
import type { AuditInput } from "./auditor.js";
import type { AgentStageDeps } from "./roles-run.js";
import { createUsageTracker } from "./usage.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-1",
  version: 1,
  ...JSON.parse(readFileSync(new URL("../../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8")),
});
const result = (caseId: string) =>
  CaseResultFileSchema.parse({
    schema: 1,
    caseId,
    runner: "api",
    attempts: [
      {
        attempt: 1,
        outcome: "passed",
        steps: [{ id: "S1", ok: true }],
        assertions: [{ stepId: "S1", field: "status", expected: 200, actual: 200, pass: true }],
        evidence: [`${caseId}/attempt-1/S1-01.json`],
      },
    ],
  });
const input: AuditInput = {
  plan,
  cases: [
    { caseId: "TC-01", status: "PASSED", result: result("TC-01"), evidence: [] },
    { caseId: "TC-02", status: "FAILED", result: result("TC-02"), evidence: [] },
  ],
  texts: {},
  images: [
    { name: "TC-01/attempt-1/S1.png", data: new Uint8Array([137, 80, 78, 71]), mediaType: "image/png" },
  ],
};
const priced = {
  tools: true,
  structuredOutput: true,
  vision: true,
  contextWindow: 200_000,
  costPerMTok: { input: 2, output: 10 },
};

/** A provider batch in memory: what was submitted, and the answer the test chooses. */
const fakeBatch = (answer: { state?: BatchState; answers?: BatchAnswer[] } = {}) => {
  const submitted: BatchCall[][] = [];
  const batch: ModelBatch = {
    priceFactor: 0.5,
    submit: (calls) => {
      submitted.push([...calls]);
      return Promise.resolve({ version: 2, id: "msgbatch_fictional", provider: "anthropic.batch" });
    },
    status: () => Promise.resolve(answer.state ?? { state: "completed" }),
    answers: () => Promise.resolve(answer.answers ?? []),
  };
  return { batch, submitted };
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
const setup = async (batch: ModelBatch | undefined) => {
  const { root, ws } = await createFetchedRun();
  roots.push(root);
  const mock = scriptedModel([{ text: "{}" }]);
  const events: RunEvent[] = [];
  const log = createEventLog({
    ticket: "DEMO-1",
    run: ws.runId,
    write: (l) => events.push(JSON.parse(l) as RunEvent),
    now: () => new Date(0),
    mask: (v) => v,
  });
  const auditor = { ...mock, id: "claude/haiku", profile: priced, ...(batch ? { batch } : {}) };
  const usage = createUsageTracker({ events: log });
  const deps: AgentStageDeps = {
    ws,
    models: {
      forRole: (role) => Promise.resolve(role === "auditor" ? auditor : { ...mock, id: "mock/author" }),
      resolve: () => Promise.resolve(auditor),
    },
    events: log,
    usage,
    now: () => new Date(0),
    maskJson: (v) => v,
    maskText: (t) => t,
  };
  return { deps, events, usage, mock, runId: ws.runId };
};
const answer = (text: string): BatchAnswer => ({
  id: "audit",
  status: "succeeded",
  text,
  usage: {
    inputTokens: 10_000,
    outputTokens: 1_000,
    inputTokenDetails: { noCacheTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokenDetails: { textTokens: 1_000, reasoningTokens: 0 },
    totalTokens: 11_000,
  },
});

describe("the audit through a provider batch (REQ-VER-06/AC4, REQ-LLM-12/AC3)", () => {
  it("REQ-VER-06/AC4: the PASSED cases go into one batched call without tools; nothing is called at once", async () => {
    const { batch, submitted } = fakeBatch();
    const { deps, events, mock } = await setup(batch);
    const queued = await queueAudit(deps, input);
    expect(queued).toMatchObject({
      model: "claude/haiku",
      sameModelAsAuthor: false,
      passed: ["TC-01"],
      batch: { id: "msgbatch_fictional", provider: "anthropic.batch" },
    });
    expect(queued?.requestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(mock.mock.doGenerateCalls).toHaveLength(0);
    const sent = JSON.stringify(submitted);
    expect(sent).toContain("TC-01/plan");
    expect(sent).not.toContain("TC-02/plan");
    expect(sent).toContain("No tools are available in this review");
    // The stored request keeps a screenshot as its hash, never its bytes.
    expect(JSON.stringify(queued?.request)).toMatch(/"sha256":"[0-9a-f]{64}","bytes":4/);
    expect(events.map((e) => e.event)).toContain("audit.queued");
  });

  it("REQ-VER-06/AC4: a provider without a batch API, or nothing PASSED, is not queued", async () => {
    expect(await queueAudit((await setup(undefined)).deps, input)).toBeUndefined();
    const { batch } = fakeBatch();
    const none = { ...input, cases: input.cases.filter((c) => c.status !== "PASSED") };
    expect(await queueAudit((await setup(batch)).deps, none)).toBeUndefined();
  });

  it("REQ-VER-06/AC4 + REQ-LLM-12/AC3: a collected answer is checked and applied; its cost is recorded at the batch price", async () => {
    const answers: BatchAnswer[] = [];
    const { batch } = fakeBatch({ answers });
    const { deps, events, usage, runId } = await setup(batch);
    // The answer names the run it reviewed.
    answers.push(
      answer(
        JSON.stringify({
          audit: runId,
          findings: [{ caseId: "TC-01", weak: true, reason: "the body shows an error" }],
        }),
      ),
    );
    const queued = await queueAudit(deps, input);
    if (!queued) throw new Error("not queued");
    const collected = await collectAudit(deps, queued);
    expect(collected).toEqual({
      status: "done",
      result: {
        model: "claude/haiku",
        sameModelAsAuthor: false,
        findings: [{ caseId: "TC-01", weak: true, reason: "the body shows an error" }],
      },
    });
    // 10k in at $2 and 1k out at $10 per million: $0.03, half at the batch price.
    expect(usage.costUsd).toBeCloseTo(0.015, 9);
    const used = events.find((e) => e.event === "model.usage");
    expect(used?.details).toMatchObject({ role: "auditor", caseIds: ["TC-01"], apportioned: true });
  });

  it("REQ-VER-06/AC4 + INV-5: pending stays pending; a failed batch, a failed call or an invalid report is a failed audit", async () => {
    const pending = fakeBatch({
      state: { state: "pending", counts: { total: 1, pending: 1, completed: 0, failed: 0 } },
    });
    const p = await setup(pending.batch);
    const queued = await queueAudit(p.deps, input);
    if (!queued) throw new Error("not queued");
    const runIdOf = p.runId;
    expect(await collectAudit(p.deps, queued)).toEqual({
      status: "pending",
      counts: { completed: 0, total: 1 },
    });
    const cases: [Parameters<typeof fakeBatch>[0], string][] = [
      [
        { state: { state: "failed", error: "expired: not processed in 24 hours" } },
        "the batch failed: expired",
      ],
      [{ answers: [{ id: "audit", status: "expired", error: "no reason given" }] }, "the audit call expired"],
      [{ answers: [] }, "the batch has no answer for the audit"],
      [{ answers: [answer("not json")] }, "the answer is not valid JSON"],
      [{ answers: [answer(JSON.stringify({ audit: runIdOf, findings: [] }))] }, "no finding for TC-01"],
      // An answer that names another run (a replayed batch) is refused.
      [
        {
          answers: [
            answer(
              JSON.stringify({
                audit: "20990101-0000-zzzz",
                findings: [{ caseId: "TC-01", weak: false, reason: "fine" }],
              }),
            ),
          ],
        },
        "reviews run 20990101-0000-zzzz",
      ],
      [
        {
          answers: [answer(JSON.stringify({ findings: [{ caseId: "TC-01", weak: false, reason: "fine" }] }))],
        },
        "not a valid audit report",
      ],
      // A finding for a case the audit did not review (here a FAILED one) is refused, never applied.
      [
        {
          answers: [
            answer(
              JSON.stringify({
                audit: runIdOf,
                findings: [
                  { caseId: "TC-01", weak: false, reason: "fine" },
                  { caseId: "TC-02", weak: false, reason: "looks passed to me" },
                ],
              }),
            ),
          ],
        },
        "TC-02 is not a PASSED case it reviewed",
      ],
    ];
    for (const [given, expected] of cases) {
      const { batch } = fakeBatch(given);
      const s = await setup(batch);
      // Each setup is a new run folder; the answer must name the run it was asked about.
      const collected = await collectAudit({ ...s.deps, ws: p.deps.ws }, queued);
      expect(collected.status, expected).toBe("failed");
      expect(collected.status === "failed" ? collected.error : "", expected).toContain(expected);
    }
  });

  it("REQ-VER-06/AC4 + REQ-FLOW-06/AC2: a call already recorded by an earlier collect is not counted again", async () => {
    const answers: BatchAnswer[] = [];
    const { batch } = fakeBatch({ answers });
    const { deps, events, usage, runId } = await setup(batch);
    answers.push(
      answer(JSON.stringify({ audit: runId, findings: [{ caseId: "TC-01", weak: false, reason: "fine" }] })),
    );
    const queued = await queueAudit(deps, input);
    if (!queued) throw new Error("not queued");
    expect((await collectAudit(deps, queued, { alreadyRecorded: true })).status).toBe("done");
    expect(usage.total).toBe(0);
    expect(events.some((e) => e.event === "model.usage")).toBe(false);
    await collectAudit(deps, queued);
    expect(events.filter((e) => e.event === "audit.batch_recorded")).toHaveLength(1);
  });
});
