import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AnalysisSchema,
  diffPlans,
  PlanSchema,
  RunIdSchema,
  TicketKeySchema,
  TicketSnapshotSchema,
  type Plan,
  type PlanDiff,
} from "@qajitsu/core";
import { coverageMatrix, type CoverageRow } from "@qajitsu/verifier";
import { parse } from "yaml";
import { consoleRun } from "./data.js";

/** What the plan review screen shows (REQ-WEB-07), all read from the run's files and computed by the code `qj approve` uses. */
export interface PlanReview {
  readonly versions: readonly number[];
  readonly approvedVersion?: number | undefined;
  /** The version on the left (the earlier one) and on the right (the one under review). */
  readonly left?: Plan | undefined;
  readonly right: Plan;
  readonly diff?: PlanDiff | undefined;
  /** The coverage matrix of the version under review (REQ-PLAN-14, AC2). */
  readonly coverage: readonly CoverageRow[];
}

/**
 * The plan review of a run (REQ-WEB-07/AC1+AC2): two versions side by side with their differences, and the coverage
 * matrix of the right one, with the "changed but not tested" rows, by the same rule `qj approve` checks.
 *
 * @param runsRoot - The project's runs root.
 * @param ticket - The ticket key.
 * @param runId - The run id.
 * @param versions - The versions to compare: the right one (default the newest) and the left one (default the one
 *   before it).
 */
export async function consolePlanReview(
  runsRoot: string,
  ticket: string,
  runId: string,
  versions: { readonly left?: number | undefined; readonly right?: number | undefined } = {},
): Promise<PlanReview | undefined> {
  const run = await consoleRun(runsRoot, ticket, runId);
  if (!run || run.planVersions.length === 0) return undefined;
  const dir = join(runsRoot, TicketKeySchema.parse(ticket), RunIdSchema.parse(runId));
  const read = async (v: number): Promise<Plan | undefined> => {
    if (!run.planVersions.includes(v)) return undefined;
    try {
      const plan = PlanSchema.parse(
        parse(await readFile(join(dir, "plan", `plan.v${String(v)}.yaml`), "utf8")),
      );
      // The file's name is the version reviewed and approved: a file that says otherwise is not shown.
      return plan.version === v ? plan : undefined;
    } catch {
      return undefined;
    }
  };
  const rightVersion = versions.right ?? run.planVersions.at(-1) ?? 1;
  const right = await read(rightVersion);
  if (!right) return undefined;
  const earlier = run.planVersions.filter((v) => v < rightVersion).at(-1);
  const left = await read(versions.left ?? earlier ?? -1);
  let criteria: readonly string[];
  try {
    criteria = TicketSnapshotSchema.parse(
      JSON.parse(await readFile(join(dir, "ticket", "ticket.json"), "utf8")),
    ).acceptanceCriteria;
  } catch {
    criteria = [];
  }
  const analysis = AnalysisSchema.safeParse(
    JSON.parse(await readFile(join(dir, "analysis.json"), "utf8").catch(() => "null")) as unknown,
  );
  return {
    versions: run.planVersions,
    ...(run.approvedVersion === undefined ? {} : { approvedVersion: run.approvedVersion }),
    ...(left ? { left, diff: diffPlans(left, right) } : {}),
    right,
    coverage: coverageMatrix(right, {
      acceptanceCriteria: criteria,
      endpoints: analysis.success ? analysis.data.endpoints : [],
    }),
  };
}
