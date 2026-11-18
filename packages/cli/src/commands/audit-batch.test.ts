import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BatchAnswer, BatchState, ModelBatch } from "@qajitsu/models";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** The provider's batch in memory: the test decides when it is answered and with what. */
const controlledBatch = () => {
  let state: BatchState = { state: "pending", counts: { total: 1, pending: 1, completed: 0, failed: 0 } };
  let answers: BatchAnswer[] = [];
  const submitted: unknown[] = [];
  const batch: ModelBatch = {
    priceFactor: 0.5,
    submit: (calls) => {
      submitted.push(calls);
      return Promise.resolve({ version: 2, id: "msgbatch_fictional_7", provider: "mock.batch" });
    },
    status: () => Promise.resolve(state),
    answers: () => Promise.resolve(answers),
  };
  const answer = (text: string) => {
    state = { state: "completed", counts: { total: 1, pending: 0, completed: 1, failed: 0 } };
    answers = [
      {
        id: "audit",
        status: "succeeded",
        text,
        usage: {
          inputTokens: 3000,
          outputTokens: 200,
          inputTokenDetails: { noCacheTokens: 3000, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokenDetails: { textTokens: 200, reasoningTokens: 0 },
          totalTokens: 3200,
        },
      },
    ];
  };
  return { batch, submitted, answer };
};
const pipeline = async (withBatch = true) => {
  const fake = controlledBatch();
  const p = await createDemoPipeline({
    config: ["verification: { auditor: optional, auditor_delivery: batch }"],
    ports: withBatch ? { extraBatches: { mock: () => fake.batch } } : {},
  });
  cleanups.push(p.cleanup);
  return { p, fake };
};
const findings = (weak: string[]) =>
  JSON.stringify({
    audit: "20261003-1046-aaaa",
    findings: ["TC-01", "TC-02"].map((caseId) => ({
      caseId,
      weak: weak.includes(caseId),
      reason: weak.includes(caseId) ? "the evidence shows an error" : "convincing",
    })),
  });

describe("the audit in a provider batch (REQ-VER-06/AC4, REQ-LLM-12/AC3)", () => {
  it("REQ-VER-06/AC4: a queued audit holds every PASSED as NEEDS_REVIEW and blocks publishing until it is collected", async () => {
    const { p, fake } = await pipeline();
    const ran = await p.executed();
    expect(ran.out).toContain("Audit queued in batch msgbatch_fictional_7");
    expect(fake.submitted).toHaveLength(1);
    // Nothing was called at once for the audit: the scripted model saw no auditor prompt.
    const audit = JSON.parse(await readFile(join(p.runDir, "checks", "audit.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(audit).toMatchObject({
      status: "queued",
      passed: ["TC-01", "TC-02"],
      batch: { id: "msgbatch_fictional_7" },
    });
    const report = await readFile(join(p.runDir, "report", "matrix.md"), "utf8");
    expect(report).toContain("NEEDS_REVIEW");
    expect(report).not.toMatch(/\| PASSED \|/);

    const published = await p.run(["publish", "DEMO-1", "--auto-publish"]);
    expect(published.exitCode).toBe(2);
    expect(published.out).toContain("Audit still in the provider's batch (0 of 1 answered)");
    expect(published.out).toContain("Not published");
    await expect(
      readFile(join(p.runDir, "report", "published", "jira-comment.adf.json"), "utf8"),
    ).rejects.toThrow();

    const pending = await p.run(["audit", "collect", "DEMO-1"]);
    expect(pending.exitCode).toBe(2);
    expect(pending.out).toContain("stay NEEDS_REVIEW until it is answered");

    // The provider answers: the findings are applied as an immediate audit's would be.
    fake.answer(findings(["TC-02"]));
    const collected = await p.run(["audit", "collect", "DEMO-1"]);
    expect(collected.err).toBe("");
    expect(collected.exitCode).toBe(0);
    expect(collected.out).toContain("Audit collected: 1 of 2 PASSED case(s) flagged.");
    const after = await readFile(join(p.runDir, "report", "matrix.md"), "utf8");
    expect(after).toMatch(/TC-01[^\n]*PASSED/);
    expect(after).toMatch(/TC-02[^\n]*NEEDS_REVIEW/);
    // Its prompt and answer are in the transcript; its use is recorded once.
    const transcript = await readFile(join(p.runDir, "journal", "agents.jsonl"), "utf8");
    expect(transcript).toContain('"role":"auditor"');
    expect(transcript).toContain("the evidence shows an error");
    const journal = await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8");
    expect(journal.match(/"model.usage"[^\n]*"role":"auditor"/g)).toHaveLength(1);
    expect(journal).toContain('"audit.queued"');
    expect(journal).toContain('"audit.done"');
    // Collecting again changes nothing; publishing now goes through.
    expect((await p.run(["audit", "collect", "DEMO-1"])).out).toContain("has no queued audit");
    expect((await p.run(["publish", "DEMO-1", "--auto-publish"])).exitCode).toBe(0);
  }, 240_000);

  it("REQ-VER-06/AC4 + INV-5: an answer that is not a valid report is a failed audit; it never makes anything better", async () => {
    const { p, fake } = await pipeline();
    await p.executed();
    // One attempt, no repair: an invalid answer could hide a weak finding, so it fails like a required audit.
    fake.answer(
      JSON.stringify({
        audit: "20261003-1046-aaaa",
        findings: [{ caseId: "TC-01", weak: false, reason: "fine" }],
      }),
    );
    const collected = await p.run(["audit", "collect", "DEMO-1"]);
    expect(collected.out).toContain(
      "Audit failed (required): the audit report is invalid: no finding for TC-02",
    );
    const matrix = await readFile(join(p.runDir, "report", "matrix.md"), "utf8");
    expect(matrix).not.toMatch(/\| PASSED \|/);
    const audit = JSON.parse(await readFile(join(p.runDir, "checks", "audit.json"), "utf8")) as {
      status: string;
    };
    expect(audit.status).toBe("failed");
  }, 240_000);

  it("REQ-VER-06/AC4 + INV-2: a request or queued record changed after queuing is refused; the cases stay NEEDS_REVIEW", async () => {
    const { p, fake } = await pipeline();
    await p.executed();
    fake.answer(findings([]));
    const requestFile = join(p.runDir, "checks", "audit-request.json");
    await writeFile(requestFile, (await readFile(requestFile, "utf8")).replace("TC-01", "TC-09"));
    const refused = await p.run(["audit", "collect", "DEMO-1"]);
    expect(refused.exitCode).toBe(3);
    expect(refused.err).toContain("[AUDIT_REQUEST_CHANGED]");
    // A forged "done" record in place of the queued one fails the integrity check: nothing becomes PASSED.
    const auditFile = join(p.runDir, "checks", "audit.json");
    await writeFile(
      auditFile,
      JSON.stringify({
        schema: 1,
        status: "done",
        mode: "optional",
        model: "mock/scripted",
        sameModelAsAuthor: false,
        findings: [],
      }),
    );
    const published = await p.run(["publish", "DEMO-1", "--auto-publish"]);
    expect(published.exitCode).not.toBe(0);
    expect(published.err).toContain("checks-intact");
    await expect(
      readFile(join(p.runDir, "report", "published", "jira-comment.adf.json"), "utf8"),
    ).rejects.toThrow();
  }, 240_000);

  it("REQ-VER-06/AC4: an auditor whose provider has no batch API audits at once and the run says why", async () => {
    const { p } = await pipeline(false);
    await p.executed();
    const audit = JSON.parse(await readFile(join(p.runDir, "checks", "audit.json"), "utf8")) as {
      status: string;
    };
    expect(audit.status).not.toBe("queued");
    const journal = await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8");
    expect(journal).toContain('"audit.batch_unavailable"');
  }, 240_000);
});
