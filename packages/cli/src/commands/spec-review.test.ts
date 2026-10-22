import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";
import { promptOf } from "../../../../tests/support/mock-model.js";
import { specReviewOn } from "./spec-review.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const fixture = (id: string) =>
  readFile(new URL(`../../../../fixtures/specs/demo-1/${id}.spec.ts`, import.meta.url), "utf8");

/** A demo run with spec review on, stopped before anything ran because its specs wait for a person. */
const waitingRun = async () => {
  const p = await createDemoPipeline({
    flag: "BUG_CART_TOTAL_ROUNDING",
    config: ["spec_review: { always: true }"],
  });
  cleanups.push(p.cleanup);
  const first = await p.executed();
  expect(first.exitCode).toBe(2);
  expect(first.out).toContain("2 spec(s) wait for a person's review: TC-01, TC-02");
  // REQ-VER-24/AC3: an unreviewed spec never runs.
  expect(await readdir(join(p.runDir, "results"))).toEqual([]);
  return p;
};

describe("human review of test code (REQ-VER-24)", () => {
  it("REQ-VER-24/AC1: off by default; on with the flag, always, or for the project's first runs", () => {
    expect(specReviewOn({ first_runs: 0, always: false }, false, 0)).toBe(false);
    expect(specReviewOn({ first_runs: 0, always: false }, true, 9)).toBe(true);
    expect(specReviewOn({ first_runs: 0, always: true }, false, 9)).toBe(true);
    expect(specReviewOn({ first_runs: 3, always: false }, false, 2)).toBe(true);
    expect(specReviewOn({ first_runs: 3, always: false }, false, 3)).toBe(false);
  });

  it("REQ-VER-24/AC2+AC4+AC5: without a terminal, a person reads each spec next to its plan and accepts it; the run then continues and the report names the reviewer", async () => {
    const p = await waitingRun();
    const shown = await p.run(["review-spec", "DEMO-1"]);
    expect(shown.out).toContain("── TC-01 Cart total is rounded once (api, sha256 ");
    expect(shown.out).toContain(
      'expect {"description":"Total is 1.01","status":200,"fields":{"total":1.01}}',
    );
    expect(shown.out).toContain('verify("S1", "fields.total"');
    expect((await p.run(["review-spec", "DEMO-1", "--accept"])).err).toContain("REVIEW_CASE_MISSING");
    for (const id of ["TC-01", "TC-02"])
      expect((await p.run(["review-spec", "DEMO-1", "--case", id, "--accept"])).out).toContain(
        `Accepted ${id}`,
      );
    const ran = await p.run(["run", "DEMO-1"]);
    // AC5: the review stopped nothing here and changed no status: the bug is FAILED, the rest PASSED.
    expect(ran.exitCode).toBe(1);
    const record = JSON.parse(await readFile(join(p.runDir, "run.json"), "utf8")) as {
      data: {
        results: Record<string, string>;
        specReviews: Record<string, { reviewer: string; sha256: string }[]>;
      };
    };
    expect(record.data.results).toEqual({ "TC-01": "FAILED", "TC-02": "PASSED" });
    expect(record.data.specReviews["TC-01"]?.[0]).toMatchObject({
      decision: "accept",
      reviewer: "qa-lead",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
    });
    expect(await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8")).toContain('"spec.review"');
    expect(await readFile(join(p.runDir, "report", "report.html"), "utf8")).toContain(
      "TC-01: spec reviewed and accepted by qa-lead",
    );
    expect((await p.run(["review-spec", "DEMO-1"])).err).toContain("RUN_ALREADY_EXECUTED");
  }, 180_000);

  it("REQ-VER-24/AC2+AC3: in a terminal, a spec sent back is written again with the reason and reviewed again", async () => {
    const p = await waitingRun();
    const spec = "```ts\n" + (await fixture("TC-01")) + "```";
    const ran = await p.run(["run", "DEMO-1"], {
      ask: ["also check the status", "y", "y"],
      script: [{ text: JSON.stringify({}) }, { text: spec }],
    });
    expect(ran.exitCode).toBe(1);
    // The spec is shown twice: before it was sent back and after the author wrote it again.
    expect(ran.out.split("── TC-01 Cart total is rounded once").length - 1).toBe(2);
    // The author got the reviewer's reason.
    expect(JSON.stringify(ran.model.mock.doGenerateCalls)).toContain("also check the status");
    // A reviewer is the person running QAJitsu: the reason is an instruction, not untrusted data the model must ignore.
    expect(JSON.stringify(ran.model.mock.doGenerateCalls)).not.toContain('source=\\"review\\"');
    expect(promptOf(ran.model, ran.model.mock.doGenerateCalls.length - 1)).toContain(
      "A reviewer sent your previous spec",
    );
    expect(await readFile(join(p.runDir, "report", "report.html"), "utf8")).toContain(
      "TC-01: spec reviewed and accepted by qa-lead (sha256",
    );
  }, 180_000);

  it("REQ-VER-24/AC3: a spec sent back twice makes its case BLOCKED and never runs", async () => {
    const p = await waitingRun();
    const spec = "```ts\n" + (await fixture("TC-01")) + "```";
    const ran = await p.run(["run", "DEMO-1"], {
      ask: ["no", "still no", "y"],
      script: [{ text: spec }],
    });
    const record = JSON.parse(await readFile(join(p.runDir, "run.json"), "utf8")) as {
      data: { results: Record<string, string> };
    };
    expect(record.data.results).toEqual({ "TC-01": "BLOCKED", "TC-02": "PASSED" });
    expect(await readFile(join(p.runDir, "results", "TC-01.json"), "utf8")).toContain(
      "a reviewer sent the spec back twice: still no",
    );
    expect(ran.exitCode).toBe(2);
  }, 180_000);

  it("REQ-VER-24/AC4: an acceptance is for exactly that spec: one changed after it waits for a person again", async () => {
    const p = await waitingRun();
    for (const id of ["TC-01", "TC-02"]) await p.run(["review-spec", "DEMO-1", "--case", id, "--accept"]);
    const file = join(p.runDir, "specs", "TC-02.spec.ts");
    await writeFile(file, `${await readFile(file, "utf8")}\n// changed after the review\n`);
    const again = await p.run(["run", "DEMO-1"]);
    expect(again.exitCode).toBe(2);
    expect(again.out).toContain("1 spec(s) wait for a person's review: TC-02");
    // Only a person is awaited: the run stops before anything starts (no estimate, no environment).
    expect(again.out).not.toContain("Estimate:");
    // Sent back without a terminal: the next run has the author write it again before asking.
    // A secret typed into the reason is masked before it is stored (invariant 8).
    await p.run([
      "review-spec",
      "DEMO-1",
      "--case",
      "TC-02",
      "--send-back",
      "remove the comment, fictional-demo-password",
    ]);
    const stored = await readFile(join(p.runDir, "run.json"), "utf8");
    expect(stored).toContain("remove the comment");
    expect(stored).not.toContain("fictional-demo-password");
    const rewritten = await p.run(["run", "DEMO-1"], {
      script: [{ text: "```ts\n" + (await fixture("TC-02")) + "```" }],
    });
    expect(rewritten.out).toContain("1 spec(s) wait for a person's review: TC-02");
    expect(await readFile(file, "utf8")).not.toContain("changed after the review");
  }, 180_000);

  it("REQ-VER-24/AC3: a rewrite that fails the checks makes the case BLOCKED once and for all, and a waiting run says so", async () => {
    const p = await waitingRun();
    await p.run(["review-spec", "DEMO-1", "--case", "TC-01", "--send-back", "send the code in the body"]);
    // The author answers without code twice: the rewrite fails; TC-02 still waits for a person.
    const first = await p.run(["run", "DEMO-1"], { script: [{ text: "no code" }] });
    expect(first.exitCode).toBe(2);
    expect(first.out).toContain("1 spec(s) wait for a person's review: TC-02");
    expect(first.out).toContain("Not run: TC-01: the spec a reviewer sent back could not be written again");
    await p.run(["review-spec", "DEMO-1", "--case", "TC-02", "--accept"]);
    // The next run does not ask the author again for TC-01.
    const second = await p.run(["run", "DEMO-1"], { script: [{ text: "no code" }] });
    expect(
      second.model.mock.doGenerateCalls.filter((c) => JSON.stringify(c).includes("Write the spec for TC-01")),
    ).toEqual([]);
    const record = JSON.parse(await readFile(join(p.runDir, "run.json"), "utf8")) as {
      data: { results: Record<string, string> };
    };
    expect(record.data.results["TC-01"]).toBe("BLOCKED");
  }, 180_000);
});
