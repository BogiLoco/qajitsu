import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TicketKeySchema } from "../identifiers.js";
import { createRunWorkspace, openRunWorkspace, type RunWorkspace } from "../workspace/run-workspace.js";
import {
  APPROVED_PLAN_FILE,
  approvePlan,
  diffPlans,
  formatPlanDiff,
  listPlanVersions,
  loadApprovedPlan,
  parsePlan,
  readPlan,
  renderPlanMarkdown,
  selectExecutableSpecs,
  sha256,
  writePlanVersion,
} from "./plan-store.js";
import { AnalysisSchema, PlanDraftSchema, type PlanDraft } from "./schemas.js";

const draft = PlanDraftSchema.parse(
  JSON.parse(readFileSync(new URL("../../../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8")),
);
const now = (): Date => new Date("2026-10-03T11:00:00Z");

describe("plan store (REQ-PLAN-02, REQ-PLAN-04, REQ-PLAN-06)", () => {
  let root: string;
  let ws: RunWorkspace;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qj-plan-"));
    ws = await createRunWorkspace({ root, ticket: TicketKeySchema.parse("DEMO-1"), now, random: () => 0 });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("REQ-PLAN-02/AC1+AC2+AC3: a case has id, title, type, priority, source, data aliases, steps with structured expectations and evidence", () => {
    const plan = parsePlan({ schema: 1, ticket: "DEMO-1", version: 1, ...draft });
    expect(plan.cases[0]?.steps[0]?.expect).toEqual({
      description: "Total is 1.01",
      status: 200,
      fields: { total: 1.01 },
    });
    expect(plan.open_questions).toEqual([]);
    expect(plan.out_of_scope).toHaveLength(1);
  });

  it("REQ-PLAN-02/AC1: rejects missing sources, secret values as data, duplicate ids and empty steps", () => {
    const bad = (mutate: (d: PlanDraft & Record<string, unknown>) => unknown) => {
      const copy = structuredClone(draft) as PlanDraft & Record<string, unknown>;
      mutate(copy);
      return () => parsePlan({ schema: 1, ticket: "DEMO-1", version: 1, ...copy });
    };
    expect(bad((d) => ((d.cases[0] as { source: unknown[] }).source = []))).toThrow(/Invalid plan/);
    expect(
      bad((d) => ((d.cases[0] as { data: Record<string, string> }).data = { password: "hunter2" })),
    ).toThrow();
    expect(bad((d) => ((d.cases[1] as { id: string }).id = "TC-01"))).toThrow();
    expect(
      bad((d) => ((d.cases[1] as { steps: unknown[] }).steps[1] = { ...(d.cases[1]?.steps[0] ?? {}) })),
    ).toThrow();
    expect(bad((d) => ((d.cases[0] as { steps: unknown[] }).steps = []))).toThrow();
  });

  it("REQ-PLAN-02/AC4: versions are kept as plan.vN.yaml and plan.vN.md", async () => {
    await writePlanVersion(ws, draft);
    const v2 = await writePlanVersion(ws, { ...draft, cases: draft.cases.slice(0, 1) });
    expect(v2.version).toBe(2);
    expect(await listPlanVersions(ws)).toEqual([1, 2]);
    expect((await readPlan(ws)).plan.cases).toHaveLength(1);
    expect((await readPlan(ws, 1)).plan.cases).toHaveLength(2);
    const md = await readFile(ws.path("plan", "plan.v1.md"), "utf8");
    expect(md).toContain("| TC-01 | Cart total is rounded once | api | high | AC1 |");
    expect(md).toContain('Expect: Total is 1.01 (status 200, fields {"total":1.01})');
    await expect(readPlan(ws, 7)).rejects.toMatchObject({ code: "PLAN_NOT_FOUND" });
  });

  it("REQ-PLAN-04/AC2: a revision shows added, removed and changed cases", () => {
    const v1 = parsePlan({ schema: 1, ticket: "DEMO-1", version: 1, ...draft });
    const changed = structuredClone(draft);
    changed.cases[0] = { ...changed.cases[0]!, title: "Cart total rounded once to 2 decimals" };
    changed.cases.splice(1, 1, { ...changed.cases[1]!, id: "TC-03" });
    const v2 = parsePlan({ schema: 1, ticket: "DEMO-1", version: 2, ...changed });
    const diff = diffPlans(v1, v2);
    expect(diff).toEqual({ added: ["TC-03"], removed: ["TC-02"], changed: ["TC-01"] });
    expect(formatPlanDiff(diff)).toBe("+ TC-03\n- TC-02\n~ TC-01");
    expect(formatPlanDiff(diffPlans(v1, v1))).toBe("(no case changes)");
  });

  it("REQ-PLAN-06/AC1: approval writes plan.approved.yaml with SHA-256, approver and time in run.json", async () => {
    await writePlanVersion(ws, draft);
    const approval = await approvePlan(ws, { approver: "qa-lead", now });
    const text = await readFile(ws.path("plan", APPROVED_PLAN_FILE), "utf8");
    expect(approval).toEqual({
      version: 1,
      sha256: sha256(text),
      approver: "qa-lead",
      at: "2026-10-03T11:00:00.000Z",
      openQuestions: 0,
      openQuestionsConfirmed: false,
    });
    const record = (await openRunWorkspace(root, ws.ticket, ws.runId)).record;
    expect(record.data["approval"]).toEqual(approval);
    expect((await loadApprovedPlan(ws)).plan.cases).toHaveLength(2);
    await expect(approvePlan(ws, { approver: "x", now })).rejects.toMatchObject({
      code: "PLAN_ALREADY_APPROVED",
    });
  });

  it("REQ-PLAN-05/AC2: approving with open questions requires explicit confirmation, recorded in run.json", async () => {
    await writePlanVersion(ws, {
      ...draft,
      open_questions: [{ id: "Q1", question: "Is rounding half-up or bankers?" }],
    });
    await expect(approvePlan(ws, { approver: "qa", now })).rejects.toMatchObject({
      code: "PLAN_OPEN_QUESTIONS",
    });
    const approval = await approvePlan(ws, { approver: "qa", now, confirmOpenQuestions: true });
    expect(approval).toMatchObject({ openQuestions: 1, openQuestionsConfirmed: true });
  });

  it("REQ-PLAN-06/AC3: a hash mismatch before execution blocks the run", async () => {
    await writePlanVersion(ws, draft);
    await approvePlan(ws, { approver: "qa", now });
    const file = ws.path("plan", APPROVED_PLAN_FILE);
    await writeFile(file, (await readFile(file, "utf8")).replace("high", "low"));
    await expect(loadApprovedPlan(ws)).rejects.toMatchObject({
      name: "GateFailedError",
      code: "PLAN_HASH_MISMATCH",
    });
    await rm(file);
    await expect(loadApprovedPlan(ws)).rejects.toMatchObject({ code: "PLAN_HASH_MISMATCH" });
  });

  it("REQ-PLAN-06/AC3: an unapproved run cannot load an approved plan", async () => {
    await expect(loadApprovedPlan(ws)).rejects.toMatchObject({ code: "PLAN_NOT_APPROVED" });
  });

  it("REQ-PLAN-06/AC4: specs for cases not in the approved plan are not executed and are reported", () => {
    const plan = parsePlan({ schema: 1, ticket: "DEMO-1", version: 1, ...draft });
    expect(
      selectExecutableSpecs(plan, [
        "specs/TC-01.spec.ts",
        "specs/TC-02.spec.ts",
        "specs/TC-99.spec.ts",
        "specs/helper.ts",
      ]),
    ).toEqual({
      execute: ["specs/TC-01.spec.ts", "specs/TC-02.spec.ts"],
      rejected: ["specs/TC-99.spec.ts", "specs/helper.ts"],
    });
  });

  it("renders open questions and empty sections", () => {
    const md = renderPlanMarkdown(
      parsePlan({
        schema: 1,
        ticket: "DEMO-1",
        version: 3,
        ...draft,
        summary: "",
        out_of_scope: [],
        open_questions: [{ id: "Q1", question: "Which locale?" }],
      }),
    );
    expect(md).toContain("- Q1: Which locale?");
    expect(md).toContain("## Out of scope\n\n_(none)_");
    expect(md).not.toContain("Already covered");
  });

  it("REQ-CTX-06/AC2: existing tests that already cover the ticket are listed for the reviewer", () => {
    const md = renderPlanMarkdown(
      parsePlan({
        schema: 1,
        ticket: "DEMO-1",
        version: 1,
        ...draft,
        existing_coverage: [
          { repo: "e2e", file: "tests/discounts.spec.ts", title: "unknown code is 404", covers: ["AC4"] },
        ],
      }),
    );
    expect(md).toContain(
      '## Already covered by existing tests\n\n- AC4: "unknown code is 404" in e2e:tests/discounts.spec.ts',
    );
  });
});

describe("analysis schema (REQ-PLAN-01)", () => {
  const base = { summary: "s", change_type: ["api"], confidence: "high" as const };
  it("REQ-PLAN-01/AC1+AC2: endpoints, screens and risks each carry sources", () => {
    expect(
      AnalysisSchema.safeParse({
        ...base,
        endpoints: [{ method: "GET", path: "/cart", source: [{ kind: "ac", id: "AC1" }] }],
      }).success,
    ).toBe(true);
    expect(
      AnalysisSchema.safeParse({ ...base, risks: [{ description: "rounding", source: [] }] }).success,
    ).toBe(false);
    expect(AnalysisSchema.safeParse({ ...base, change_type: [] }).success).toBe(false);
  });
  it("REQ-PLAN-01/AC3: low confidence requires open questions", () => {
    expect(AnalysisSchema.safeParse({ ...base, confidence: "low" }).success).toBe(false);
    expect(
      AnalysisSchema.safeParse({
        ...base,
        confidence: "low",
        open_questions: [{ id: "Q1", question: "Which endpoint?" }],
      }).success,
    ).toBe(true);
  });
});
