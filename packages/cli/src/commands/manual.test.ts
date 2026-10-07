import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGuard, createJournal, DEFAULT_PROTECTED_PATHS } from "@qajitsu/guard";
import { afterEach, describe, expect, it } from "vitest";
import { apiService, createBuildProject, draft } from "../../../../tests/support/cli-build.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** TC-02 gets a manual step S3 (check the confirmation e-mail); its spec marks the step without verifying it. */
const MANUAL_STEP = {
  id: "S3",
  action: "Check the discount confirmation SMS",
  manual: true,
  instructions: "Open the test phone and read the SMS from the shop.",
  expect: { description: "The SMS says SAVE20 was applied" },
};

const setup = async (timeoutS = 30) => {
  const p = await createBuildProject(`${apiService()}\nmanual: { timeout_s: ${String(timeoutS)} }`);
  cleanups.push(p.cleanup);
  const plan = JSON.parse(draft) as { cases: { steps: unknown[] }[] };
  plan.cases[1]?.steps.push(MANUAL_STEP);
  const dir = await p.prepare(JSON.stringify(plan));
  const spec = join(dir, "specs", "TC-02.spec.ts");
  await writeFile(
    spec,
    (await readFile(spec, "utf8")).replace(/\n}\s*$/, '\n  await step("S3", () => {});\n}\n'),
  );
  const results = async () =>
    (
      JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as {
        data: { results: Record<string, string> };
      }
    ).data.results;
  const go = (extra: { ask?: string[] } = {}) => p.run(["run", "DEMO-1", "--build"], undefined, extra);
  return { ...p, dir, results, go };
};

describe("manual steps in a run (REQ-EXEC-11)", () => {
  it("REQ-EXEC-11/AC2+AC3+AC6: the run pauses, the tester answers in the terminal; matrix, evidence and Jira name who", async () => {
    const p = await setup();
    const r = await p.go({ ask: ["maybe", "p", "SMS arrived, code 482913", ""] });
    expect(r.out).toContain("Manual step TC-02 S3: Check the discount confirmation SMS");
    expect(r.out).toContain("Do: Open the test phone and read the SMS from the shop.");
    expect(r.out).toContain("Expected: The SMS says SAVE20 was applied");
    expect(await p.results()).toEqual({ "TC-01": "PASSED", "TC-02": "PASSED" });
    const result = JSON.parse(await readFile(join(p.dir, "results", "TC-02.json"), "utf8")) as {
      attempts: { assertions: Record<string, unknown>[] }[];
    };
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.assertions.find((a) => a["stepId"] === "S3")).toMatchObject({
      field: "manual",
      actual: "passed",
      pass: true,
      source: "manual",
      by: "qa-lead",
      note: "SMS arrived, code ***",
    });
    const manifest = await readFile(join(p.dir, "evidence", "manifest.json"), "utf8");
    expect(manifest).toContain("TC-02/attempt-1/S3-manual.json");
    expect(
      await readFile(join(p.dir, "evidence", "TC-02", "attempt-1", "S3-manual.json"), "utf8"),
    ).not.toContain("482913");
    expect(await readFile(join(p.dir, "report", "matrix.md"), "utf8")).toMatch(
      /\| TC-02 \|.*\| PASSED \|.*\| S3 passed by qa-lead \|/,
    );
    expect(await readFile(join(p.dir, "report", "report.html"), "utf8")).toContain(
      "Manual: S3 passed by qa-lead",
    );
    expect((await p.run(["publish", "DEMO-1"], undefined, { ask: ["y"] })).exitCode).toBe(0);
    expect(await readFile(join(p.dir, "report", "published", "jira-comment.wiki.txt"), "utf8")).toContain(
      "h4. Manual steps (performed by people)",
    );
  }, 240_000);

  it("REQ-EXEC-11/AC5: a manual step reported failed makes the case FAILED", async () => {
    const p = await setup();
    const r = await p.go({ ask: ["f", "no SMS at all", ""] });
    expect(r.exitCode).toBe(1);
    expect(await p.results()).toEqual({ "TC-01": "PASSED", "TC-02": "FAILED" });
  }, 240_000);

  it("REQ-EXEC-11/AC2: in CI the run waits for 'qj answer' from someone else; only a waiting step can be answered", async () => {
    const p = await setup();
    expect((await p.run(["answer", "DEMO-1", "TC-02", "S3", "--passed"])).err).toContain("[NO_PENDING_STEP]");
    const running = p.go();
    const pending = join(p.dir, "manual", "TC-02.S3.pending.json");
    for (
      let i = 0;
      i < 300 &&
      !(await readFile(pending).then(
        () => true,
        () => false,
      ));
      i++
    )
      await new Promise((done) => setTimeout(done, 100));
    expect((await p.run(["answer", "DEMO-1", "TC-02", "S3"])).err).toContain("[ANSWER_OUTCOME_REQUIRED]");
    const answered = await p.run([
      "answer",
      "DEMO-1",
      "TC-02",
      "S3",
      "--failed",
      "--note",
      "SMS shows SAVE10",
    ]);
    expect(answered.out).toContain("Answered TC-02 S3: failed (by qa-lead).");
    const r = await running;
    expect(r.out).toContain("Waiting for a person (30 s): qajitsu answer DEMO-1 TC-02 S3 --passed|--failed");
    expect(await p.results()).toEqual({ "TC-01": "PASSED", "TC-02": "FAILED" });
    expect(await readdir(join(p.dir, "manual"))).not.toContain("TC-02.S3.pending.json");
  }, 240_000);

  it("REQ-EXEC-11/AC5: nobody answers in time: BLOCKED, never PASSED, and not retried", async () => {
    const p = await setup(1);
    const r = await p.go();
    expect(r.exitCode).not.toBe(0);
    expect(await p.results()).toEqual({ "TC-01": "PASSED", "TC-02": "BLOCKED" });
    const result = JSON.parse(await readFile(join(p.dir, "results", "TC-02.json"), "utf8")) as {
      attempts: { error?: string }[];
    };
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.error).toContain("manual step S3 was not answered in time");
  }, 240_000);
});

describe("agents cannot answer for a tester (REQ-EXEC-11/AC4)", () => {
  it("REQ-EXEC-11/AC4: writing a manual answer is denied by the guard and journaled", () => {
    const lines: string[] = [];
    const journal = createJournal(
      (l) => lines.push(l),
      () => new Date("2026-10-07T10:00:00Z"),
      (v) => v,
    );
    const guard = createGuard({
      run: "20261007-1000-abcd",
      stage: "author",
      journal,
      policy: {
        workspaceRoot: "/runs/DEMO-1/20261007-1000-abcd",
        allowedTools: new Set(["write_file"]),
        writeTools: new Set(["write_file"]),
        protectedPaths: DEFAULT_PROTECTED_PATHS,
        networkTools: new Set(),
        allowedOrigins: [],
      },
    });
    const decision = guard.check({
      tool: "write_file",
      input: { path: "manual/TC-02.S3.answer.json", content: '{"outcome":"passed","by":"qa-lead"}' },
    });
    expect(decision.allowed).toBe(false);
    expect(lines.join("\n")).toContain("manual/TC-02.S3.answer.json");
  });
});
