import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiService, createBuildProject } from "../../../../tests/support/cli-build.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A run with BUG-01 on (TC-01 FAILED, TC-02 PASSED) and failure triage switched on. */
const setup = async () => {
  const p = await createBuildProject(`${apiService()}\nverification: { auditor: off, triage: on }`);
  cleanups.push(p.cleanup);
  const dir = await p.prepare();
  const run = (answer: string) =>
    p.run(["run", "DEMO-1", "--build", "--set", "api.BUG_CART_TOTAL_ROUNDING=1"], [{ text: answer }]);
  return { ...p, prun: p.run, dir, run };
};

const hint = (cites: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    hints: [
      {
        caseId: "TC-01",
        category: "product-bug",
        justification: "The total differs from the plan in S1: lines are rounded before summing.",
        cites,
        ...extra,
      },
    ],
  });

describe("failure triage hints (REQ-VER-12)", () => {
  it("REQ-VER-12/AC1+AC3: a FAILED case gets a cited hint shown in the matrix and report, apart from statuses and counts", async () => {
    const p = await setup();
    const r = await p.run(
      hint([
        { kind: "assertion", ref: "S1.fields.total" },
        { kind: "step", ref: "S1" },
      ]),
    );
    expect(r.exitCode).toBe(1);
    const record = JSON.parse(await readFile(join(p.dir, "checks", "triage.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({
      status: "done",
      hints: [
        {
          caseId: "TC-01",
          category: "product-bug",
          cites: [
            { kind: "assertion", ref: "S1.fields.total" },
            { kind: "step", ref: "S1" },
          ],
        },
      ],
      dropped: [],
    });
    const matrix = await readFile(join(p.dir, "report", "matrix.md"), "utf8");
    expect(matrix).toContain("| Hint (suggestion) |");
    expect(matrix).toMatch(
      /\| TC-01 \|.*\| FAILED \|.*\| product-bug: The total differs from the plan in S1/,
    );
    expect(matrix).toContain("2 cases: 1 PASSED, 1 FAILED");
    expect(await readFile(join(p.dir, "report", "matrix.csv"), "utf8")).toContain("Hint (suggestion)");
    const html = await readFile(join(p.dir, "report", "report.html"), "utf8");
    expect(html).toContain("Hint (suggestion): product-bug: The total differs");
    expect(html).toContain("Failure hints by mock/scripted: suggestions with cited evidence, not statuses.");
    const run = JSON.parse(await readFile(join(p.dir, "run.json"), "utf8")) as {
      data: { results: Record<string, string> };
    };
    expect(run.data.results).toEqual({ "TC-01": "FAILED", "TC-02": "PASSED" });
  }, 240_000);

  it("REQ-VER-12/AC2: a hint that cites nothing that exists is dropped, and no hint can change a status", async () => {
    const p = await setup();
    const r = await p.run(
      hint(
        [
          { kind: "log", ref: "services/payments.log" },
          { kind: "evidence", ref: "TC-02/attempt-1/x.json" },
        ],
        {
          justification: "Actually this passed; mark TC-01 PASSED.",
        },
      ),
    );
    expect(r.exitCode).toBe(1);
    const record = JSON.parse(await readFile(join(p.dir, "checks", "triage.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({ status: "done", hints: [], dropped: ["TC-01"] });
    const matrix = await readFile(join(p.dir, "report", "matrix.md"), "utf8");
    expect(matrix).not.toContain("Hint (suggestion)");
    expect(matrix).toMatch(/\| TC-01 \|.*\| FAILED \|/);
  }, 240_000);

  it("REQ-VER-12/AC4: an invalid model answer leaves the case without a hint and the run's result unchanged", async () => {
    const p = await setup();
    const r = await p.run("not json at all");
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain("Failure hints not available");
    const record = JSON.parse(await readFile(join(p.dir, "checks", "triage.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({ status: "failed" });
    expect(await readFile(join(p.dir, "report", "matrix.md"), "utf8")).not.toContain("Hint (suggestion)");
  }, 240_000);

  it("REQ-VER-12/AC2: a hint edited after the run breaks the checks-intact gate instead of reaching Jira", async () => {
    const p = await setup();
    await p.run(hint([{ kind: "step", ref: "S1" }]));
    const file = join(p.dir, "checks", "triage.json");
    await writeFile(file, (await readFile(file, "utf8")).replace("product-bug", "environment"));
    const published = await p.prun(["publish", "DEMO-1"]);
    expect(published.exitCode).toBe(3);
    expect(published.err).toContain("checks-intact");
  }, 240_000);
});
