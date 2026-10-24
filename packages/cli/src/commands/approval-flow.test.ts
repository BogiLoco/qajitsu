import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline, flowScript } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const answer = (decision: string, reasons: string[] = []) => ({
  text: JSON.stringify({ decision, reasons }),
});

/** A fetched and planned DEMO-1 run with an approval flow; the approver model is another than the planner's. */
const planned = async (
  flow: string,
  extra: { transformPlan?: (d: string) => string; jira?: "off" | "comment" } = {},
) => {
  const p = await createDemoPipeline({
    config: [`approval: { flow: ${flow}, model: mock/approver, jira: ${extra.jira ?? "off"} }`],
    ...(extra.transformPlan ? { transformPlan: extra.transformPlan } : {}),
  });
  cleanups.push(p.cleanup);
  await p.run(["fetch", "DEMO-1"]);
  const [analysis, draft] = flowScript("DEMO-1");
  const plan = extra.transformPlan ? { text: extra.transformPlan((draft as { text: string }).text) } : draft;
  await p.run(["plan", "DEMO-1"], { script: [analysis as never, plan as never] });
  const record = async () =>
    JSON.parse(await readFile(join(p.runDir, "run.json"), "utf8")) as {
      data: {
        approval?: { approver: string; sha256: string; modelOnly?: boolean };
        approvals?: {
          kind: string;
          identity: string;
          decision: string;
          planSha256: string;
          promptSha256?: string;
          answerSha256?: string;
          reasons?: string[];
        }[];
      };
    };
  return { ...p, record };
};

describe("approval flow with person and model steps (REQ-PLAN-10)", () => {
  it("REQ-PLAN-10/AC1+AC3: a model step, then a person; both decisions are recorded with hashes in run.json and the journal", async () => {
    const p = await planned("[model, person]");
    const r = await p.run(["approve", "DEMO-1"], {
      script: [answer("approve", ["every criterion has a case"])],
    });
    expect(r.err).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("Step 1 (model mock/approver): approve — every criterion has a case");
    expect(r.out).toContain("Step 2 (person qa-lead): approve");
    const { data } = await p.record();
    expect(data.approval?.approver).toBe("qa-lead");
    expect(data.approval?.modelOnly).toBeUndefined();
    expect(data.approvals?.map((a) => [a.kind, a.identity, a.decision])).toEqual([
      ["model", "mock/approver", "approve"],
      ["person", "qa-lead", "approve"],
    ]);
    const [model, person] = data.approvals ?? [];
    expect(model?.planSha256).toBe(data.approval?.sha256);
    expect(person?.planSha256).toBe(data.approval?.sha256);
    expect(model?.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(model?.answerSha256).toMatch(/^[0-9a-f]{64}$/);
    const journal = await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8");
    expect(journal.match(/"event":"approval.step"/g)).toHaveLength(2);
    expect(journal).toContain(model?.answerSha256 ?? "x");
  }, 120_000);

  it("REQ-PLAN-10/AC1: a flow of a model only approves the plan without a person, marked as such", async () => {
    const p = await planned("[model]");
    const r = await p.run(["approve", "DEMO-1"], { script: [answer("approve", ["fine"])] });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("Approved plan v1 of DEMO-1");
    expect(r.out).toContain("approved by a model only (mock/approver)");
    const { data } = await p.record();
    expect(data.approval).toMatchObject({ approver: "model:mock/approver", modelOnly: true });
  }, 120_000);

  it("REQ-PLAN-10/AC2: revise stops with the reasons and the command to revise; nothing is approved", async () => {
    const p = await planned("[model, person]");
    const r = await p.run(["approve", "DEMO-1"], {
      script: [answer("revise", ["TC-02 needs the SAVE10 total.", "TC-03 must quote AC3;"])],
    });
    expect(r.exitCode).toBe(2);
    expect(r.out).toContain("Step 1 (model mock/approver): revise — TC-02 needs the SAVE10 total.");
    expect(r.out).toContain("The model approver asks for a revision (reasons above).");
    expect(r.out).toContain(
      'qajitsu plan DEMO-1 --revise "TC-02 needs the SAVE10 total; TC-03 must quote AC3" --run',
    );
    expect((await p.record()).data.approval).toBeUndefined();
  }, 120_000);

  it("REQ-PLAN-10/AC2: a plan with open questions goes to a person without asking the model; without a person step --person decides", async () => {
    const withQuestion = (d: string) => {
      const plan = JSON.parse(d) as { open_questions: unknown[] };
      plan.open_questions = [{ id: "Q1", question: "Which rounding mode applies?" }];
      return JSON.stringify(plan);
    };
    const p = await planned("[model]", { transformPlan: withQuestion });
    const r = await p.run(["approve", "DEMO-1"]);
    expect(r.exitCode).toBe(2);
    expect(r.out).toContain(
      "Step 1 (code): handover — the plan has 1 open question(s)\n    - Q1 Which rounding mode applies?",
    );
    expect(r.out).toContain("A person must decide: approve it with --person (and --confirm-open-questions)");
    const person = await p.run(["approve", "DEMO-1", "--person", "--confirm-open-questions"]);
    expect(person.exitCode).toBe(0);
    const { data } = await p.record();
    expect(data.approval?.approver).toBe("qa-lead");
    expect(data.approvals?.map((a) => [a.kind, a.decision])).toEqual([
      ["code", "handover"],
      ["person", "approve"],
    ]);
  }, 120_000);
});

describe("approval in the interactive plan review (REQ-PLAN-10/AC3)", () => {
  it("REQ-PLAN-10/AC3: accepting in the review is a person's step, recorded, commented and intact for the audit", async () => {
    const p = await createDemoPipeline({
      config: ["approval: { flow: [model], model: mock/approver, jira: comment }"],
    });
    cleanups.push(p.cleanup);
    await p.run(["fetch", "DEMO-1"]);
    const [analysis, draft] = flowScript("DEMO-1");
    const r = await p.run(["plan", "DEMO-1"], { script: [analysis as never, draft as never], ask: ["a"] });
    expect(r.err).toBe("");
    expect(r.out).toContain(
      "A person approved in the review: the model steps of the approval flow (model) were not run.",
    );
    const record = JSON.parse(await readFile(join(p.runDir, "run.json"), "utf8")) as {
      data: {
        approval: { approver: string; sha256: string };
        approvals: { kind: string; planSha256: string }[];
      };
    };
    expect(record.data.approvals.map((a) => [a.kind, a.planSha256])).toEqual([
      ["person", record.data.approval.sha256],
    ]);
    const audit = await p.run(["audit", "verify", "DEMO-1"]);
    expect(audit.exitCode).toBe(0);
    expect(audit.out).toContain("approval of plan v1 by qa-lead, 1 step(s) match the journal");
    const files = await readdir(join(p.runDir, "report", "published"));
    expect(files).toContain("jira-comment.approval-1.wiki.txt");
    expect(files).toContain("jira-comment.approval-frozen.wiki.txt");
  }, 120_000);
});

describe("plans code flagged (REQ-PLAN-10/AC2)", () => {
  it("REQ-PLAN-10/AC2: flagged expectations go to the person step without asking the model, one per line; the person still confirms them", async () => {
    const placeholder = (d: string) =>
      d.replace('"fields": { "total": 1.01 }', '"fields": { "total": "TBD" }');
    const p = await planned("[model, person]", { transformPlan: placeholder });
    const r = await p.run(["approve", "DEMO-1"]);
    expect(r.out).toContain(
      "Step 1 (code): handover — code flagged 1 expectation(s) it cannot check\n    - TC-01 S1",
    );
    expect(r.out).not.toContain("! TC-01");
    expect(r.exitCode).toBe(3);
    expect(r.err).toContain("--confirm-placeholders");
    expect((await p.record()).data.approval).toBeUndefined();
    const confirmed = await p.run(["approve", "DEMO-1", "--confirm-placeholders"]);
    expect(confirmed.exitCode).toBe(0);
    expect((await p.record()).data.approval?.approver).toBe("qa-lead");
  }, 120_000);
});

describe("approval comments in Jira (REQ-PLAN-10/AC4)", () => {
  it("REQ-PLAN-10/AC4: the plan, every decision and the freeze are separate comments on the ticket, with the hashes", async () => {
    const p = await planned("[model, person]", { jira: "comment" });
    const r = await p.run(["approve", "DEMO-1"], {
      script: [answer("approve", ["every criterion has a case"])],
    });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("Posted the plan on DEMO-1");
    const dir = join(p.runDir, "report", "published");
    expect((await readdir(dir)).filter((f) => f.endsWith(".wiki.txt")).sort()).toEqual([
      "jira-comment.approval-1.wiki.txt",
      "jira-comment.approval-2.wiki.txt",
      "jira-comment.approval-frozen.wiki.txt",
      "jira-comment.plan.wiki.txt",
      // The readiness gate's result is a comment of its own before the plan (REQ-PLAN-13/AC4).
      "jira-comment.readiness.wiki.txt",
    ]);
    const { data } = await p.record();
    const model = await readFile(join(dir, "jira-comment.approval-1.wiki.txt"), "utf8");
    expect(model).toContain("step 1 of 2: model mock/approver decided approve");
    expect(model).toContain("Reason: every criterion has a case");
    expect(model).toContain(`Answer sha256 ${data.approvals?.[0]?.answerSha256 ?? "x"}`);
    expect(await readFile(join(dir, "jira-comment.approval-2.wiki.txt"), "utf8")).toContain(
      "step 2 of 2: person qa-lead decided approve",
    );
    expect(await readFile(join(dir, "jira-comment.approval-frozen.wiki.txt"), "utf8")).toContain(
      `Plan sha256 ${data.approval?.sha256 ?? "x"}`,
    );
    const journal = await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8");
    expect(journal.match(/"event":"approval.commented"/g)).toHaveLength(3);
  }, 120_000);

  it("REQ-PLAN-10/AC4: a revision request is a comment too; a later approval adds new comments instead of overwriting", async () => {
    const p = await planned("[model]", { jira: "comment" });
    await p.run(["approve", "DEMO-1"], { script: [answer("revise", ["TC-02 needs the SAVE10 total"])] });
    await p.run(["approve", "DEMO-1"], { script: [answer("approve", ["fine now"])] });
    const dir = join(p.runDir, "report", "published");
    expect(await readFile(join(dir, "jira-comment.approval-1.wiki.txt"), "utf8")).toContain(
      "Reason: TC-02 needs the SAVE10 total",
    );
    expect(await readFile(join(dir, "jira-comment.approval-2.wiki.txt"), "utf8")).toContain(
      "decided approve",
    );
  }, 120_000);

  it("REQ-PLAN-10/AC4: Jira failing to take a comment is reported and journaled, and never changes the decision", async () => {
    const p = await planned("[model]", { jira: "comment" });
    await mkdir(join(p.runDir, "report"), { recursive: true });
    // The readiness comment of the plan stage already made the folder; Jira fails for the approval comments.
    await rm(join(p.runDir, "report", "published"), { recursive: true, force: true });
    await writeFile(join(p.runDir, "report", "published"), "not a folder");
    const r = await p.run(["approve", "DEMO-1"], { script: [answer("approve", ["fine"])] });
    expect(r.exitCode).toBe(0);
    expect(r.err).toContain("Warning: the approval comment approval-1 was not posted to DEMO-1");
    expect((await p.record()).data.approval?.modelOnly).toBe(true);
    const journal = await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8");
    expect(journal).toContain('"event":"approval.comment_failed"');
  }, 120_000);
});

describe("audit of approval records (REQ-PLAN-10/AC6)", () => {
  it("REQ-PLAN-10/AC6: qj audit verify accepts intact approval records and rejects a changed step or plan file", async () => {
    const p = await planned("[model]");
    await p.run(["approve", "DEMO-1"], { script: [answer("approve", ["fine"])] });
    const ok = await p.run(["audit", "verify", "DEMO-1"]);
    expect(ok.exitCode).toBe(0);
    expect(ok.out).toContain(
      "approval of plan v1 by a model only (mock/approver), 1 step(s) match the journal",
    );
    const file = join(p.runDir, "run.json");
    const record = JSON.parse(await readFile(file, "utf8")) as {
      data: { approvals: { reasons: string[] }[] };
    };
    const [step] = record.data.approvals;
    if (step) step.reasons = ["a person looked at it"];
    await writeFile(file, JSON.stringify(record, null, 2));
    await writeFile(join(p.runDir, "plan", "plan.approved.yaml"), "cases: []\n");
    const bad = await p.run(["audit", "verify", "DEMO-1"]);
    expect(bad.exitCode).toBe(1);
    expect(bad.out).toContain("plan.approved.yaml does not match the approved sha256");
    expect(bad.out).toContain("approval step 1 (model mock/approver approve) is not in the journal");
  }, 120_000);
});

describe("results of a plan no person approved (REQ-PLAN-10/AC5)", () => {
  const executed = async (modelOnly: string) => {
    const p = await createDemoPipeline({
      config: [`approval: { flow: [model], model: mock/approver, model_only: ${modelOnly} }`],
      approveScript: [answer("approve", ["fine"])],
    });
    cleanups.push(p.cleanup);
    const r = await p.executed();
    const report = async (name: string) => readFile(join(p.runDir, "report", name), "utf8");
    return { p, r, report };
  };

  it("REQ-PLAN-10/AC5: as-computed keeps the statuses code computed; matrix, report and junit say no person approved", async () => {
    const { r, report } = await executed("as-computed");
    expect(r.out).toContain("2 cases: 2 PASSED");
    const note = "was approved by a model only (mock/approver";
    expect(await report("matrix.md")).toContain(note);
    expect(await report("report.html")).toContain(note);
    expect(await report("junit.xml")).toContain('name="qajitsu.plan.approval"');
  }, 180_000);

  it("REQ-PLAN-10/AC5: model_only: review moves PASSED to NEEDS_REVIEW, with the reason", async () => {
    const { r, report } = await executed("review");
    expect(r.out).toContain("2 cases: 2 NEEDS_REVIEW");
    expect(await report("report.html")).toContain(
      "TC-01 → NEEDS_REVIEW (plan approved by a model only (model:mock/approver)",
    );
  }, 180_000);

  it("REQ-PLAN-10/AC5+AC6: removing the model-only marker from run.json fails the approval-intact gate: nothing is published", async () => {
    const { p } = await executed("as-computed");
    const file = join(p.runDir, "run.json");
    const record = JSON.parse(await readFile(file, "utf8")) as {
      data: { approval: Record<string, unknown> };
    };
    delete record.data.approval["modelOnly"];
    record.data.approval["approver"] = "qa-lead";
    await writeFile(file, JSON.stringify(record, null, 2));
    const r = await p.run(["publish", "DEMO-1", "--auto-publish"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.err).toContain(
      "Publish gates failed: approval-intact (run.json says a person approved plan sha256",
    );
  }, 180_000);
});
