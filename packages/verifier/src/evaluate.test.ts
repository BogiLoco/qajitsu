import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanSchema, type CaseResultFile, type EvidenceEntry } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkManifest,
  combineGates,
  evaluateCases,
  evaluateRun,
  gateFailedIsExplained,
  gateNoSecrets,
  gatePassedIsProven,
} from "./evaluate.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-1",
  version: 1,
  cases: ["TC-01", "TC-02", "TC-03", "TC-04"].map((id) => ({
    id,
    title: `case ${id}`,
    type: "api",
    priority: "high",
    source: [{ kind: "ac", id: "AC1" }],
    steps: [
      { id: "S1", action: "a", expect: { description: "d", status: 200 } },
      { id: "S2", action: "b", expect: { description: "d", status: 200 } },
    ],
    evidence: ["response"],
  })),
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const ok = (stepId: string) => ({ stepId, field: "status", expected: 200, actual: 200, pass: true });
const bad = (stepId: string) => ({ stepId, field: "status", expected: 200, actual: 500, pass: false });
const attempt = (
  n: number,
  outcome: "passed" | "failed" | "error" | "skipped",
  assertions: ReturnType<typeof ok>[],
  caseId: string,
  steps = ["S1", "S2"],
) => ({
  attempt: n,
  outcome,
  assertions,
  steps: steps.map((id) => ({ id, ok: true })),
  evidence: steps.map((s) => `${caseId}/attempt-${String(n)}/${s}-01.json`),
});

const setup = async () => {
  const dir = await mkdtemp(join(tmpdir(), "qj-eval-"));
  dirs.push(dir);
  const results = new Map<string, CaseResultFile>([
    [
      "TC-01",
      {
        schema: 1,
        caseId: "TC-01",
        runner: "api",
        attempts: [attempt(1, "passed", [ok("S1"), ok("S2")], "TC-01")],
      },
    ],
    [
      "TC-02",
      {
        schema: 1,
        caseId: "TC-02",
        runner: "api",
        attempts: [
          attempt(1, "failed", [ok("S1"), bad("S2")], "TC-02"),
          attempt(2, "failed", [ok("S1"), bad("S2")], "TC-02"),
        ],
      },
    ],
    [
      "TC-03",
      {
        schema: 1,
        caseId: "TC-03",
        runner: "api",
        attempts: [
          attempt(1, "failed", [bad("S1")], "TC-03"),
          attempt(2, "passed", [ok("S1"), ok("S2")], "TC-03"),
        ],
      },
    ],
  ]);
  const manifest: EvidenceEntry[] = [];
  for (const r of results.values()) {
    for (const a of r.attempts) {
      for (const path of a.evidence) {
        const content = `{"call":"${path}"}`;
        await mkdir(join(dir, path, ".."), { recursive: true });
        await writeFile(join(dir, path), content);
        manifest.push({
          path,
          caseId: r.caseId,
          stepId: path.split("/").at(-1)!.split("-")[0]!,
          kind: "response",
          sha256: createHash("sha256").update(content).digest("hex"),
          bytes: content.length,
        });
      }
    }
  }
  return { dir, results, manifest };
};

describe("run evaluation (REQ-VER-02, REQ-VER-05, REQ-VER-07)", () => {
  it("REQ-VER-02: computes PASSED, FAILED, FLAKY and NOT_RUN from runner results only", async () => {
    const { dir, results, manifest } = await setup();
    const check = await checkManifest(dir, manifest);
    const cases = evaluateCases(plan, results, manifest, check);
    expect(cases.map((c) => [c.caseId, c.status, c.stepsPassed])).toEqual([
      ["TC-01", "PASSED", 2],
      ["TC-02", "FAILED", 1],
      ["TC-03", "FLAKY", 2],
      ["TC-04", "NOT_RUN", 0],
    ]);
    expect(cases[1]?.failures).toEqual([bad("S2")]);
    const { gates } = evaluateRun({
      plan,
      results,
      reportedCaseIds: [...results.keys()],
      manifest,
      manifestCheck: check,
      approvedSha256: "a".repeat(64),
      currentSha256: "a".repeat(64),
    });
    expect(combineGates(gates)).toEqual({ ok: true, failed: [] });
  });

  it("REQ-VER-05/AC2 + REQ-VER-07/AC5: a tampered or missing evidence file breaks the manifest gate and PASSED", async () => {
    const { dir, results, manifest } = await setup();
    await writeFile(join(dir, "TC-01/attempt-1/S2-01.json"), '{"call":"edited"}');
    await rm(join(dir, "TC-02/attempt-2/S1-01.json"));
    const check = await checkManifest(dir, manifest);
    expect(check.problems).toEqual([
      "TC-01/attempt-1/S2-01.json: hash or size differs from the manifest",
      "TC-02/attempt-2/S1-01.json: listed in the manifest but missing",
    ]);
    const { cases, gates } = evaluateRun({
      plan,
      results,
      reportedCaseIds: [...results.keys()],
      manifest,
      manifestCheck: check,
      approvedSha256: "a",
      currentSha256: "a",
    });
    expect(cases[0]?.status).toBe("NEEDS_REVIEW");
    expect(combineGates(gates).failed.map((g) => g.gate)).toEqual(["manifest-intact"]);
  });

  it("REQ-VER-07/AC1+AC2: results outside the plan and a changed plan fail the gates", async () => {
    const { dir, results, manifest } = await setup();
    const check = await checkManifest(dir, manifest);
    const { gates } = evaluateRun({
      plan,
      results,
      reportedCaseIds: [...results.keys(), "TC-77"],
      manifest,
      manifestCheck: check,
      approvedSha256: "a",
      currentSha256: "b",
    });
    expect(combineGates(gates).failed.map((g) => g.gate)).toEqual([
      "every-approved-case-has-one-status",
      "approved-plan-unchanged",
    ]);
  });

  it("REQ-VER-07/AC3: PASSED without verify or without evidence for a step is caught", async () => {
    const { dir, results, manifest } = await setup();
    const check = await checkManifest(dir, manifest);
    const fake = [
      {
        caseId: "TC-04",
        status: "PASSED" as const,
        stepsPassed: 2,
        stepsTotal: 2,
        evidenceComplete: true,
        attempts: 1,
        failures: [],
        evidence: [],
      },
    ];
    const lying = new Map(results);
    lying.set("TC-04", {
      schema: 1,
      caseId: "TC-04",
      runner: "api",
      attempts: [{ ...attempt(1, "passed", [], "TC-04"), evidence: [] }],
    });
    expect(gatePassedIsProven(plan, fake, lying, manifest, check).problems).toEqual([
      "TC-04: PASSED without an executed verify()",
      "TC-04: PASSED without evidence for S1",
      "TC-04: PASSED without evidence for S2",
      // REQ-LLM-05/AC2: every planned expectation needs its own verify().
      "TC-04: PASSED without a verify() of S1 status",
      "TC-04: PASSED without a verify() of S2 status",
    ]);
  });

  it("REQ-VER-07/AC4: FAILED needs expected, actual and evidence of the failing step", () => {
    const base = {
      stepsPassed: 0,
      stepsTotal: 2,
      evidenceComplete: false,
      attempts: 1,
      status: "FAILED" as const,
    };
    expect(
      gateFailedIsExplained([
        { ...base, caseId: "TC-01", failures: [], evidence: [] },
        {
          ...base,
          caseId: "TC-02",
          failures: [{ stepId: "S1", field: "status", expected: undefined, actual: 500, pass: false }],
          evidence: [],
        },
      ]).problems,
    ).toEqual([
      "TC-01: FAILED without a failed assertion",
      "TC-02.S1.status: FAILED without expected and actual values",
      "TC-02.S1: FAILED without evidence of the failing step",
    ]);
  });

  it("REQ-VER-07/AC6 + REQ-CFG-06/AC3: the secret scan blocks artifacts with a registered secret", () => {
    const gate = gateNoSecrets(
      [
        { name: "matrix.md", text: "ok" },
        { name: "report.html", text: "token sk-live-123456" },
      ],
      (t) => t.includes("sk-live-123456"),
    );
    expect(gate).toEqual({
      gate: "no-secrets",
      ok: false,
      problems: ["report.html: contains a secret value"],
    });
  });

  it("counts failed steps and requires a verify() for every step of a PASSED case", async () => {
    const { dir, results, manifest } = await setup();
    const check = await checkManifest(dir, manifest);
    const crashed = new Map(results);
    const first = results.get("TC-01")!.attempts[0]!;
    crashed.set("TC-01", {
      schema: 1,
      caseId: "TC-01",
      runner: "api",
      attempts: [
        {
          ...first,
          steps: [
            { id: "S1", ok: true },
            { id: "S2", ok: false, error: "x" },
          ],
          error: "boom",
        },
      ],
    });
    const [tc1] = evaluateCases(plan, crashed, manifest, check);
    expect(tc1).toMatchObject({ stepsPassed: 1, error: "boom" });
    const onlyS1 = new Map(results);
    onlyS1.set("TC-01", {
      schema: 1,
      caseId: "TC-01",
      runner: "api",
      attempts: [{ ...first, assertions: [ok("S1")] }],
    });
    expect(evaluateCases(plan, onlyS1, manifest, check)[0]?.status).toBe("NEEDS_REVIEW");
    // REQ-LLM-05/AC2: a step verified only partly (a planned field left out) is never PASSED.
    const partial = {
      ...plan,
      cases: plan.cases.map((c, i) =>
        i === 0
          ? { ...c, steps: c.steps.map((st) => ({ ...st, expect: { ...st.expect, fields: { total: 1 } } })) }
          : c,
      ),
    };
    expect(evaluateCases(partial, results, manifest, check)[0]?.status).toBe("NEEDS_REVIEW");
    const fake = [
      {
        caseId: "TC-01",
        status: "PASSED" as const,
        stepsPassed: 2,
        stepsTotal: 2,
        evidenceComplete: true,
        attempts: 1,
        failures: [],
        evidence: [],
      },
    ];
    expect(gatePassedIsProven(plan, fake, onlyS1, manifest, check).problems).toEqual([
      "TC-01: PASSED without a verify() for S2",
      "TC-01: PASSED without a verify() of S2 status",
    ]);
    const ghost = [{ ...fake[0]!, caseId: "TC-99" }];
    expect(gatePassedIsProven(plan, ghost, new Map(), manifest, check).problems).toEqual([
      "TC-99: PASSED without an executed verify()",
    ]);
  });
});
