import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildProject, draft, PASSWORD } from "../../../../tests/support/cli-build.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A run of DEMO-1 with BUG-01 on: TC-01 FAILED, TC-02 PASSED; bugs are written to report/bugs. */
const setup = async (planDraft = draft) => {
  const p = await createBuildProject();
  cleanups.push(p.cleanup);
  const dir = await p.prepare(planDraft);
  await p.run(["run", "DEMO-1", "--build", "--set", "api.BUG_CART_TOTAL_ROUNDING=1"]);
  const bugs = join(dir, "report", "bugs");
  const files = async () => (await readdir(bugs).catch(() => [] as string[])).sort();
  return { ...p, dir, bugs, files };
};

describe("qj bug (REQ-PUB-07)", () => {
  it("REQ-PUB-07/AC2+AC3+AC4: the report comes from plan, runner and run record; created only after confirmation and linked", async () => {
    const p = await setup();
    const quiet = await p.run(["bug", "DEMO-1"]);
    expect(quiet.exitCode).toBe(2);
    expect(quiet.err).toContain("TC-01: not interactive; create with --yes.");
    expect(await p.files()).toEqual([]);
    expect((await p.run(["bug", "DEMO-1"], undefined, { ask: ["s"] })).exitCode).toBe(2);

    const created = await p.run(["bug", "DEMO-1", "--yes"]);
    expect(created.err).toBe("");
    expect(created.exitCode).toBe(0);
    expect(created.out).toContain("TC-01: created DEMO-9001");
    expect(created.out).toContain("linked to DEMO-1");
    expect(await p.files()).toEqual(["DEMO-9001.json", "link-DEMO-9001-DEMO-1.json"]);
    const bug = JSON.parse(await readFile(join(p.bugs, "DEMO-9001.json"), "utf8")) as {
      summary: string;
      labels: string[];
      description: { text: string };
    };
    expect(bug.summary).toMatch(/^Cart total is rounded once: S1 fields\.total expected 1\.01 but was /);
    expect(bug.labels).toEqual(["qajitsu"]);
    const text = bug.description.text;
    expect(text).toContain("Steps to reproduce (approved test plan, with what the runner recorded):");
    expect(text).toContain("S1: GET /cart (failed: fields.total)");
    expect(text).toContain("Preconditions:");
    expect(text).toContain("Test data user: user:standard");
    expect(text).toMatch(/S1 fields\.total: expected 1\.01, actual 1\.0\d/);
    expect(text).toMatch(/Repository shop at [0-9a-f]{40}/);
    expect(text).toMatch(/Environment: build \(local\) \(http:\/\/127\.0\.0\.1:\d+\)/);
    expect(text).toMatch(/TC-01\/attempt-\d\/S1-\d+\.json \(response\) sha256 [0-9a-f]{16}…/);
    expect(text).toContain(`QAJitsu run ${p.dir.split("/").at(-1) ?? ""} while testing DEMO-1`);
    // Reported once; a second call does not create another bug.
    const again = await p.run(["bug", "DEMO-1", "--yes"]);
    expect(again.out).toContain("TC-01: already reported as DEMO-9001.");
    expect(await p.files()).toHaveLength(2);
  }, 240_000);

  it("REQ-PUB-07/AC1: similar open bugs are shown first; the failure can be linked to one instead of a new bug", async () => {
    const p = await setup();
    await writeFile(
      join(p.project, "tickets", "DEMO-7.json"),
      JSON.stringify({ key: "DEMO-7", type: "Bug", status: "Open", summary: "Cart total rounded wrongly" }),
    );
    const refused = await p.run(["bug", "DEMO-1", "--yes"]);
    expect(refused.exitCode).toBe(2);
    expect(refused.out).toContain("Similar open bugs:\n  DEMO-7 Cart total rounded wrongly (Open)");
    expect(refused.err).toContain(
      "similar open bugs exist; link one with --link <KEY> or create anyway with --yes --force-new",
    );
    const linked = await p.run(["bug", "DEMO-1"], undefined, { ask: ["l DEMO-7"] });
    expect(linked.exitCode).toBe(0);
    expect(linked.out).toContain("TC-01: linked DEMO-1 to DEMO-7.");
    expect(await p.files()).toEqual(["link-DEMO-1-DEMO-7.json"]);
    const run = JSON.parse(await readFile(join(p.dir, "run.json"), "utf8")) as { data: { bugs: unknown[] } };
    expect(run.data.bugs).toMatchObject([{ caseId: "TC-01", key: "DEMO-7", created: false, by: "qa-lead" }]);
  }, 240_000);

  it("REQ-PUB-07/AC1: --link and --yes --force-new act without a terminal; only FAILED cases can be reported", async () => {
    const p = await setup();
    expect((await p.run(["bug", "DEMO-1", "--cases", "TC-02", "--yes"])).err).toContain("TC-02: PASSED");
    expect((await p.run(["bug", "DEMO-1", "--link", "DEMO-7"])).exitCode).toBe(0);
    expect(await p.files()).toEqual(["link-DEMO-1-DEMO-7.json"]);
  }, 240_000);

  it("REQ-PUB-07/AC5: a run whose texts carry a secret value never produces a bug, and the error does not repeat it", async () => {
    const leaky = JSON.parse(draft) as { cases: { title: string }[] };
    const first = leaky.cases[0];
    if (first) first.title = `Cart total for ${PASSWORD}`;
    const p = await setup(JSON.stringify(leaky));
    const r = await p.run(["bug", "DEMO-1", "--yes"]);
    expect(r.exitCode).toBe(3);
    expect(r.err).toMatch(/\[(BUG_GATES_FAILED|BUG_CONTAINS_SECRET)\]/);
    expect(r.err + r.out).not.toContain(PASSWORD);
    expect(await p.files()).toEqual([]);
  }, 240_000);
});
