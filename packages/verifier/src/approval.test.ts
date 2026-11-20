import type { ApprovalStep, PlanApproval, RunEvent } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { checkApprovalRecords } from "./approval.js";

const SHA = "a".repeat(64);
const approval = (over: Partial<PlanApproval> = {}): PlanApproval => ({
  version: 1,
  sha256: SHA,
  approver: "model:local/qwen3:14b",
  at: "2026-10-18T10:00:00.000Z",
  openQuestions: 0,
  openQuestionsConfirmed: false,
  modelOnly: true,
  ...over,
});
const byPersonApproval = (): PlanApproval => {
  const rest: PlanApproval = { ...approval({ approver: "qa-lead" }) };
  delete (rest as { modelOnly?: true }).modelOnly;
  return rest;
};
const modelStep: ApprovalStep = {
  kind: "model",
  identity: "local/qwen3:14b",
  decision: "approve",
  reasons: ["fine"],
  version: 1,
  planSha256: SHA,
  at: "2026-10-18T10:00:00.000Z",
  promptSha256: "b".repeat(64),
  answerSha256: "c".repeat(64),
};
const event = (name: string, details: unknown): RunEvent => ({
  ts: "2026-10-18T10:00:00.000Z",
  run: "r",
  ticket: "DEMO-1",
  stage: "approve",
  actor: { kind: "agent", name: "x" },
  event: name,
  details,
});
const journal = (a: PlanApproval, steps: readonly ApprovalStep[]): RunEvent[] => [
  ...steps.map((s) => event("approval.step", s)),
  event("plan.approved", a),
];

describe("approval records against the journal (REQ-PLAN-10/AC3+AC5+AC6, ADR-0010)", () => {
  it("REQ-PLAN-10/AC3: intact records of a model-only approval are accepted and reported as model-only", () => {
    expect(checkApprovalRecords(approval(), [modelStep], journal(approval(), [modelStep]))).toEqual({
      modelOnly: true,
      problems: [],
    });
  });

  it("REQ-PLAN-10/AC3: a run approved before approval flows (no steps, nothing in the journal) has nothing to check", () => {
    const legacy = byPersonApproval();
    expect(checkApprovalRecords(legacy, [], [])).toEqual({ modelOnly: false, problems: [] });
  });

  it("REQ-PLAN-10/AC5: removing modelOnly from run.json does not hide a model-only approval: the journal says so", () => {
    const forged = byPersonApproval();
    const result = checkApprovalRecords(forged, [modelStep], journal(approval(), [modelStep]));
    expect(result.modelOnly).toBe(true);
    expect(result.problems).toContain(
      "run.json says a person approved plan sha256 aaaaaaaaaaaa, the journal says a model only",
    );
  });

  it("REQ-PLAN-10/AC6: a step changed, added or deleted in run.json does not match the journal", () => {
    const changed = { ...modelStep, decision: "approve" as const, reasons: ["looks great"] };
    expect(checkApprovalRecords(approval(), [changed], journal(approval(), [modelStep])).problems).toEqual([
      "approval step 1 (model local/qwen3:14b approve) is not in the journal",
      "the journal has an approval step that run.json does not (model local/qwen3:14b approve)",
    ]);
    const revise = { ...modelStep, decision: "revise" as const };
    expect(
      checkApprovalRecords(approval(), [modelStep], journal(approval(), [revise, modelStep])).problems,
    ).toEqual(["the journal has an approval step that run.json does not (model local/qwen3:14b revise)"]);
  });

  it("REQ-PLAN-10/AC6: the frozen plan must be the one an approving step decided on, by the recorded approver", () => {
    const other = { ...modelStep, planSha256: "d".repeat(64) };
    expect(checkApprovalRecords(approval(), [other], journal(approval(), [other])).problems).toEqual([
      "no approval step approved plan sha256 aaaaaaaaaaaa as model:local/qwen3:14b",
    ]);
    const person: ApprovalStep = { ...modelStep, kind: "person", identity: "qa-lead", reasons: [] };
    const byPerson = byPersonApproval();
    expect(
      checkApprovalRecords(byPerson, [modelStep, person], journal(byPerson, [modelStep, person])),
    ).toEqual({
      modelOnly: false,
      problems: [],
    });
    // Only a model step approved, yet run.json names a person and no model-only marker.
    expect(checkApprovalRecords(byPerson, [modelStep], journal(byPerson, [modelStep])).problems).toEqual([
      "no approval step approved plan sha256 aaaaaaaaaaaa as qa-lead",
    ]);
  });
});

// Found by mutation testing (REQ-NFR-14): every field of a step, every half of the approver check, and the journal
// events that do and do not count.
describe("approval records, each check on its own (REQ-PLAN-10/AC3+AC5+AC6, REQ-NFR-14)", () => {
  const OTHER = "d".repeat(64);

  it.each([
    ["identity", "local/llama3:8b"],
    ["kind", "person"],
    ["decision", "revise"],
    ["version", 2],
    ["planSha256", OTHER],
    ["at", "2026-10-18T11:00:00.000Z"],
    ["promptSha256", OTHER],
    ["answerSha256", OTHER],
  ] as const)(
    "REQ-PLAN-10/AC6: a step whose %s was edited in run.json is not the journaled one",
    (field, value) => {
      const edited = { ...modelStep, [field]: value };
      const { problems } = checkApprovalRecords(approval(), [edited], journal(approval(), [modelStep]));
      expect(
        problems.some((p) => p.startsWith("approval step 1 (") && p.endsWith("is not in the journal")),
      ).toBe(true);
    },
  );

  it("REQ-PLAN-10/AC6: the extra journaled step is named, not the first one", () => {
    const revise = { ...modelStep, decision: "revise" as const };
    expect(
      checkApprovalRecords(approval(), [modelStep], journal(approval(), [modelStep, revise])).problems,
    ).toEqual(["the journal has an approval step that run.json does not (model local/qwen3:14b revise)"]);
  });

  it("REQ-PLAN-10/AC6: steps only in run.json, or only in the journal, still need an approving step", () => {
    const other = { ...modelStep, planSha256: OTHER };
    const noApprover = "no approval step approved plan sha256 aaaaaaaaaaaa as model:local/qwen3:14b";
    expect(checkApprovalRecords(approval(), [other], []).problems).toEqual([
      "approval step 1 (model local/qwen3:14b approve) is not in the journal",
      noApprover,
    ]);
    expect(checkApprovalRecords(approval(), [], journal(approval(), [modelStep])).problems).toEqual([
      "the journal has an approval step that run.json does not (model local/qwen3:14b approve)",
      noApprover,
    ]);
  });

  it("REQ-PLAN-10/AC6: a step that asked for a revision never counts as the approval", () => {
    const revise = { ...modelStep, decision: "revise" as const };
    expect(checkApprovalRecords(approval(), [revise], journal(approval(), [revise])).problems).toEqual([
      "no approval step approved plan sha256 aaaaaaaaaaaa as model:local/qwen3:14b",
    ]);
  });

  it("REQ-PLAN-10/AC6: a model-only approval needs a model step by that same model", () => {
    const asPerson: ApprovalStep = { ...modelStep, kind: "person" };
    const otherModel: ApprovalStep = { ...modelStep, identity: "local/llama3:8b" };
    for (const step of [asPerson, otherModel])
      expect(checkApprovalRecords(approval(), [step], journal(approval(), [step])).problems).toEqual([
        "no approval step approved plan sha256 aaaaaaaaaaaa as model:local/qwen3:14b",
      ]);
  });

  it("REQ-PLAN-10/AC6: a person's approval needs a person step by that same person", () => {
    const byPerson = byPersonApproval();
    const modelNamedLikeThePerson: ApprovalStep = { ...modelStep, identity: "qa-lead" };
    const otherPerson: ApprovalStep = { ...modelStep, kind: "person", identity: "dev-1", reasons: [] };
    for (const step of [modelNamedLikeThePerson, otherPerson])
      expect(checkApprovalRecords(byPerson, [step], journal(byPerson, [step])).problems).toEqual([
        "no approval step approved plan sha256 aaaaaaaaaaaa as qa-lead",
      ]);
  });

  it("REQ-PLAN-10/AC5: only the journaled approval of this plan decides model-only, not other events or versions", () => {
    const byPerson = byPersonApproval();
    const person: ApprovalStep = { ...modelStep, kind: "person", identity: "qa-lead", reasons: [] };
    const events = [
      event("plan.approved", { ...approval(), sha256: OTHER }),
      event("plan.drafted", { sha256: SHA, modelOnly: true }),
      event("plan.approved", undefined),
      ...journal(byPerson, [person]),
    ];
    expect(checkApprovalRecords(byPerson, [person], events)).toEqual({ modelOnly: false, problems: [] });
  });

  it("REQ-PLAN-10/AC5: run.json saying model-only stays model-only even when the journal does not say so", () => {
    expect(checkApprovalRecords(approval(), [], []).modelOnly).toBe(true);
  });

  it("REQ-PLAN-10/AC6: the untouched record is accepted, so each failure above is the edit alone", () => {
    expect(checkApprovalRecords(approval(), [modelStep], journal(approval(), [modelStep])).problems).toEqual(
      [],
    );
  });
});
