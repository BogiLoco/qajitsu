// Adversarial suite: a lying agent or a tampered file tries to change what gets executed after approval.
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPROVED_PLAN_FILE,
  PlanDraftSchema,
  TicketKeySchema,
  approvePlan,
  createRunWorkspace,
  loadApprovedPlan,
  selectExecutableSpecs,
  writePlanVersion,
  type RunWorkspace,
} from "@qajitsu/core";
import { createGuard, createJournal, DEFAULT_PROTECTED_PATHS } from "@qajitsu/guard";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const draft = PlanDraftSchema.parse(
  JSON.parse(readFileSync(new URL("../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8")),
);
const now = (): Date => new Date("2026-10-03T11:00:00Z");

describe("invariant 3: approved plan is frozen (REQ-PLAN-06)", () => {
  let root: string;
  let ws: RunWorkspace;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qj-adv-plan-"));
    ws = await createRunWorkspace({ root, ticket: TicketKeySchema.parse("DEMO-1"), now, random: () => 0 });
    await writePlanVersion(ws, draft);
    await approvePlan(ws, { approver: "qa", now });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("REQ-PLAN-06/AC2: the guard denies agent writes, moves and deletes of plan.approved.yaml", () => {
    const lines: string[] = [];
    const guard = createGuard({
      run: ws.runId,
      stage: "author",
      policy: {
        workspaceRoot: ws.dir,
        allowedTools: new Set(["write_file", "move_file", "delete_file"]),
        writeTools: new Set(["write_file", "move_file", "delete_file"]),
        protectedPaths: DEFAULT_PROTECTED_PATHS,
        networkTools: new Set(),
        allowedOrigins: [],
      },
      journal: createJournal(
        (l) => lines.push(l),
        now,
        (v) => v,
      ),
    });
    for (const call of [
      { tool: "write_file", input: { path: "plan/plan.approved.yaml", content: "cases: []" } },
      { tool: "write_file", input: { path: "plan/../plan/plan.approved.yaml", content: "x" } },
      { tool: "move_file", input: { path: "plan/plan.v1.yaml", to: "plan/plan.approved.yaml" } },
      { tool: "delete_file", input: { path: "plan/plan.approved.yaml" } },
    ]) {
      expect(guard.check(call)).toMatchObject({ allowed: false });
    }
  });

  it("REQ-PLAN-06/AC3: weakening an expectation after approval is caught by the hash check", async () => {
    const file = ws.path("plan", APPROVED_PLAN_FILE);
    await writeFile(file, (await readFile(file, "utf8")).replace("total: 1.01", "total: 1.02"));
    await expect(loadApprovedPlan(ws)).rejects.toMatchObject({ code: "PLAN_HASH_MISMATCH" });
  });

  it("REQ-PLAN-06/AC3: rewriting the hash in run.json is not enough when the file differs from the approved version", async () => {
    const file = ws.path("plan", APPROVED_PLAN_FILE);
    await writeFile(file, (await readFile(file, "utf8")).replace("TC-02", "TC-09"));
    // A lying agent cannot write run.json (guard), and the hash is recomputed from file bytes each time.
    await expect(loadApprovedPlan(ws)).rejects.toMatchObject({ code: "PLAN_HASH_MISMATCH" });
  });

  it("REQ-PLAN-06/AC4: a smuggled spec for an unapproved case is not executed", async () => {
    const { plan } = await loadApprovedPlan(ws);
    const { execute, rejected } = selectExecutableSpecs(plan, [
      "specs/TC-01.spec.ts",
      "specs/TC-77-extra-pass.spec.ts",
      "specs/TC-01.spec.ts.bak",
    ]);
    expect(execute).toEqual(["specs/TC-01.spec.ts"]);
    expect(rejected).toEqual(["specs/TC-77-extra-pass.spec.ts", "specs/TC-01.spec.ts.bak"]);
  });
});
