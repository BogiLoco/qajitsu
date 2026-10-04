import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiService, createBuildProject } from "../../../../tests/support/cli-build.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const setup = async (verification: string) => {
  const p = await createBuildProject(`${apiService()}\nverification: ${verification}`);
  cleanups.push(p.cleanup);
  return p;
};
const statuses = async (dir: string) =>
  (JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as { data: { results: Record<string, string> } })
    .data.results;
const json = async (file: string) => JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;

describe("auditor in qj run (REQ-VER-06)", () => {
  it("REQ-VER-06/AC1 + AC2: a weak finding turns that PASSED into NEEDS_REVIEW; the rest stays; the report says why", async () => {
    const { run, prepare } = await setup("{ auditor: optional }");
    const dir = await prepare();
    const findings = {
      findings: [
        { caseId: "TC-01", weak: true, reason: "S1 evidence shows a different cart than the plan" },
        { caseId: "TC-02", weak: false, reason: "assertions match the plan" },
      ],
    };
    const result = await run(["run", "DEMO-1", "--build"], [{ text: JSON.stringify(findings) }]);
    expect(result.exitCode).toBe(2);
    expect(await statuses(dir)).toEqual({ "TC-01": "NEEDS_REVIEW", "TC-02": "PASSED" });
    expect(await json(join(dir, "checks", "audit.json"))).toMatchObject({
      status: "done",
      mode: "optional",
      model: "mock/scripted",
      sameModelAsAuthor: true,
    });
    const html = await readFile(join(dir, "report", "report.html"), "utf8");
    expect(html).toContain("Verification checks");
    expect(html).toContain(
      "TC-01 → NEEDS_REVIEW (auditor: S1 evidence shows a different cart than the plan)",
    );
    expect(html).toContain("the auditor used the author&#39;s model");
    // The results written by the runner are untouched; the downgrade is computed.
    expect(JSON.stringify(await json(join(dir, "results", "TC-01.json")))).toContain('"outcome":"passed"');
  }, 120_000);

  it("REQ-VER-06: an auditor that cannot answer changes nothing when optional and blocks PASSED when required", async () => {
    const optional = await setup("{ auditor: optional }");
    const a = await optional.prepare();
    const okRun = await optional.run(["run", "DEMO-1", "--build"], [{ text: "I think everything is fine" }]);
    expect(okRun.err).toContain("Auditor did not complete (optional)");
    expect(okRun.exitCode).toBe(0);
    expect(await statuses(a)).toEqual({ "TC-01": "PASSED", "TC-02": "PASSED" });

    const required = await setup("{ auditor: required }");
    const b = await required.prepare();
    expect((await required.run(["run", "DEMO-1", "--build"], [{ text: "no" }])).exitCode).toBe(2);
    expect(await statuses(b)).toEqual({ "TC-01": "NEEDS_REVIEW", "TC-02": "NEEDS_REVIEW" });
  }, 180_000);
});

describe("canary in qj run (REQ-VER-09)", () => {
  it("REQ-VER-09/AC1: a working test fails its inverted expectation and the run stays PASSED", async () => {
    const { run, prepare } = await setup("{ auditor: off, canary: true }");
    const dir = await prepare();
    expect((await run(["run", "DEMO-1", "--build"])).exitCode).toBe(0);
    expect(await json(join(dir, "checks", "canary.json"))).toMatchObject({
      caseId: "TC-01",
      stepId: "S1",
      field: "status",
      caught: true,
    });
    expect(await statuses(dir)).toEqual({ "TC-01": "PASSED", "TC-02": "PASSED" });
    // Canary evidence is not part of the run's manifest.
    expect(await readFile(join(dir, "evidence", "manifest.json"), "utf8")).not.toContain("canary");
  }, 120_000);

  it("REQ-VER-09/AC2: when a broken runner lets the inverted expectation pass, the whole run is NEEDS_REVIEW", async () => {
    const { inProcessExecutor } = await import("../../../../tests/support/cli-pipeline.js");
    // A runner bug the other checks would not see: every assertion reported as passed.
    const broken = async (input: Parameters<typeof inProcessExecutor>[0]) => {
      const record = await inProcessExecutor(input);
      return {
        ...record,
        outcome: "passed" as const,
        assertions: record.assertions.map((x) => ({ ...x, actual: x.expected, pass: true })),
      };
    };
    const p = await createBuildProject(`${apiService()}\nverification: { auditor: off, canary: true }`, {
      ports: { executor: broken },
    });
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    const result = await p.run(["run", "DEMO-1", "--build"]);
    expect(result.exitCode).toBe(2);
    expect(await json(join(dir, "checks", "canary.json"))).toMatchObject({ caught: false });
    expect(await statuses(dir)).toEqual({ "TC-01": "NEEDS_REVIEW", "TC-02": "NEEDS_REVIEW" });
    expect(await readFile(join(dir, "report", "report.html"), "utf8")).toContain(
      "PASSED with an inverted expectation",
    );
  }, 120_000);
});
