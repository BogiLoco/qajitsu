// Adversarial suite: a batched audit tries to make results look better than they are (REQ-VER-06/AC4, INV-5).
// Scenario catalogue: .claude/skills/adversarial-test/scenarios.md
import { TEST_STATUSES, type AuditRecord } from "@qajitsu/core";
import { createGuard, createJournal, DEFAULT_PROTECTED_PATHS } from "@qajitsu/guard";
import { applyVerificationChecks } from "@qajitsu/verifier";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelBatch } from "@qajitsu/models";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../support/cli-pipeline.js";

const all = TEST_STATUSES.map((status, i) => ({ caseId: `TC-0${String(i + 1)}`, status }));
const queued = (mode: "optional" | "required"): AuditRecord => ({
  schema: 1,
  status: "queued",
  mode,
  model: "claude/haiku",
  sameModelAsAuthor: false,
  passed: all.filter((c) => c.status === "PASSED").map((c) => c.caseId),
  batch: { version: 2, id: "msgbatch_fictional", provider: "anthropic.batch" },
  submittedAt: "2026-11-18T10:00:00.000Z",
  requestSha256: "b".repeat(64),
  resultsSha256: "c".repeat(64),
});

describe("a batched audit can only hold back, never upgrade (REQ-VER-06/AC4, invariant 5)", () => {
  it("REQ-VER-06/AC4 + INV-5: while queued, no status moves up and every PASSED waits as NEEDS_REVIEW", () => {
    for (const mode of ["optional", "required"] as const) {
      const checked = applyVerificationChecks(all, queued(mode));
      for (const [i, c] of checked.entries()) {
        const before = all[i]?.status ?? "PASSED";
        expect(
          c.status === before || (before === "PASSED" && c.status === "NEEDS_REVIEW"),
          `${mode} ${before}`,
        ).toBe(true);
      }
    }
  });

  it("REQ-VER-06/AC4 + INV-2: an agent cannot write the queued record, the stored request or the collected one", () => {
    const guard = createGuard({
      run: "20261118-1000-abcd",
      stage: "audit",
      policy: {
        workspaceRoot: "/runs/DEMO-1/20261118-1000-abcd",
        allowedTools: new Set(["write_file"]),
        writeTools: new Set(["write_file"]),
        protectedPaths: DEFAULT_PROTECTED_PATHS,
        networkTools: new Set(),
        allowedOrigins: [],
      },
      journal: createJournal(
        () => undefined,
        () => new Date("2026-11-18T10:00:00Z"),
        (v) => v,
      ),
    });
    for (const path of ["checks/audit.json", "checks/audit-request.json", "Checks/Audit.json", "run.json"])
      expect(guard.check({ tool: "write_file", input: { path, content: "{}" } }).allowed, path).toBe(false);
  });
});

describe("a batched audit over the run's files (REQ-VER-06/AC4)", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });
  const answered = (runId: string, weak: string[] = []) =>
    JSON.stringify({
      audit: runId,
      findings: ["TC-01", "TC-02"].map((caseId) => ({
        caseId,
        weak: weak.includes(caseId),
        reason: "reviewed",
      })),
    });
  const batchOf = () => {
    let text: string | undefined;
    const batch: ModelBatch = {
      priceFactor: 0.5,
      submit: () => Promise.resolve({ version: 2, id: "msgbatch_fictional_9", provider: "mock.batch" }),
      status: () => Promise.resolve(text === undefined ? { state: "pending" } : { state: "completed" }),
      answers: () =>
        Promise.resolve(
          text === undefined
            ? []
            : [
                {
                  id: "audit",
                  status: "succeeded" as const,
                  text,
                  usage: {
                    inputTokens: 100,
                    outputTokens: 10,
                    inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
                    outputTokenDetails: { textTokens: 10, reasoningTokens: 0 },
                    totalTokens: 110,
                  },
                },
              ],
        ),
    };
    return { batch, answer: (t: string) => (text = t) };
  };

  it("REQ-VER-06/AC4 + INV-1: an answer about results that changed since it was queued is a required failure", async () => {
    const fake = batchOf();
    const p = await createDemoPipeline({
      config: ["verification: { auditor: optional, auditor_delivery: batch }"],
      ports: { extraBatches: { mock: () => fake.batch } },
    });
    cleanups.push(p.cleanup);
    await p.executed();
    const runId = p.runDir.split("/").at(-1) ?? "";
    // The results the audit reviewed are no longer the run's (here rewritten; in practice a rerun of the cases).
    const file = join(p.runDir, "results", "TC-01.json");
    await writeFile(file, `${await readFile(file, "utf8")} `);
    fake.answer(answered(runId));
    const collected = await p.run(["audit", "collect", "DEMO-1"]);
    expect(collected.out).toContain(
      "Audit failed (required): the results changed after the audit was queued",
    );
    expect(await readFile(join(p.runDir, "report", "matrix.md"), "utf8")).not.toMatch(/\| PASSED \|/);
  }, 240_000);

  it("REQ-VER-06/AC4 + REQ-VER-15: nothing is certified while queued; the collected audit gets a new certificate", async () => {
    const fake = batchOf();
    const env: Record<string, string> = {};
    const p = await createDemoPipeline({
      config: [
        "verification: { auditor: optional, auditor_delivery: batch }",
        "certificate: { signing_key: secret://env/QAJITSU_SIGNING_KEY }",
      ],
      ports: { extraBatches: { mock: () => fake.batch } },
      env,
    });
    cleanups.push(p.cleanup);
    const keygen = await p.run(["audit", "keygen"]);
    env["QAJITSU_SIGNING_KEY"] = Buffer.from(
      await readFile(/Private key \(mode 0600\): (\S+)/.exec(keygen.out)?.[1] ?? ""),
    ).toString("base64");
    const ran = await p.executed();
    expect(ran.out).toContain("No certificate yet: the audit is still in batch msgbatch_fictional_9");
    expect((await p.run(["audit", "certify", "DEMO-1"])).exitCode).toBe(1);
    fake.answer(answered(p.runDir.split("/").at(-1) ?? ""));
    expect((await p.run(["audit", "collect", "DEMO-1"])).exitCode).toBe(0);
    const certified = await p.run(["audit", "certify", "DEMO-1"]);
    expect(certified.exitCode).toBe(0);
    expect(certified.out).toContain("Issued");
    // The certificate covers the collected record and the reports as they are now.
    expect((await p.run(["audit", "certify", "DEMO-1"])).out).toContain("still valid");
  }, 240_000);
});
