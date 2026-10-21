import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline, flowScript } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** DEMO-1 planned without the fixture's exclusions: AC2 and AC4 are covered by no case. */
const planned = async (config: string[] = []) => {
  const withoutExclusions = (d: string) => {
    const plan = JSON.parse(d) as { out_of_scope: string[] };
    plan.out_of_scope = plan.out_of_scope.filter((o) => !/^AC\d/.test(o));
    return JSON.stringify(plan);
  };
  const p = await createDemoPipeline({ transformPlan: withoutExclusions, config });
  cleanups.push(p.cleanup);
  await p.run(["fetch", "DEMO-1"]);
  const [analysis, draft] = flowScript("DEMO-1");
  const r = await p.run(["plan", "DEMO-1"], {
    script: [analysis as never, { text: withoutExclusions((draft as { text: string }).text) }],
  });
  return { p, plan: r };
};

describe("coverage computed by code in qj plan and approve (REQ-PLAN-14)", () => {
  it("REQ-PLAN-14/AC3+AC4: the gaps are listed next to the plan; approve refuses them unless confirmed, and records the confirmation", async () => {
    const { p, plan } = await planned();
    expect(plan.out).toContain(
      'Not covered by any case (2):\n  ? AC2 "POST /cart/discount with a valid code reduces the total by the code\'s percentage."',
    );
    expect(plan.out).toContain(
      'Add a case, or exclude each on purpose in out_of_scope with a reason, e.g. "AC2: why".',
    );
    const refused = await p.run(["approve", "DEMO-1"]);
    expect(refused.exitCode).toBe(3);
    expect(refused.err).toContain(
      "Error [PLAN_UNCOVERED]: 2 item(s) of the ticket or the change are covered by no case",
    );
    expect(refused.err).toMatch(/ {2}- AC4 "An unknown code returns 404/);
    const confirmed = await p.run(["approve", "DEMO-1", "--confirm-uncovered"]);
    expect(confirmed.exitCode).toBe(0);
    const record = JSON.parse(await readFile(join(p.runDir, "run.json"), "utf8")) as {
      data: { planCoverage: { confirmedBy: string; gaps: { id: string }[] } };
    };
    expect(record.data.planCoverage.confirmedBy).toBe("qa-lead");
    expect(record.data.planCoverage.gaps.map((g) => g.id)).toEqual(["AC2", "AC4"]);
  }, 120_000);

  it("REQ-PLAN-14/AC4 + REQ-PLAN-10/AC2: a model approver is not asked about a plan with gaps; a person decides", async () => {
    const { p } = await planned(["approval: { flow: [model], model: mock/approver }"]);
    const r = await p.run(["approve", "DEMO-1"]);
    expect(r.exitCode).toBe(2);
    expect(r.out).toContain(
      "Step 1 (code): handover — the plan covers 2 item(s) of the ticket or the change with no case",
    );
    expect(r.out).toContain("A person must decide: approve it with --person (and --confirm-uncovered)");
  }, 120_000);
});
