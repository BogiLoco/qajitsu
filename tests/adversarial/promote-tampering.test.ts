// Adversarial suite: someone tries to promote cases that did not pass, or code that is not what passed.
// Scenario catalogue: .claude/skills/adversarial-test/scenarios.md
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildProject, draft, PASSWORD } from "../support/cli-build.js";
import { gitExec } from "../support/cli-project.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const setup = async (planDraft = draft) => {
  const p = await createBuildProject();
  cleanups.push(p.cleanup);
  const testsRepo = join(p.home, "git", "demo-org", "shop-tests");
  await gitExec(["init", "-q", "-b", "main", testsRepo]);
  await mkdir(join(testsRepo, "tests"));
  await writeFile(join(testsRepo, "tests", "a.spec.ts"), "");
  await gitExec(["-C", testsRepo, "add", "."]);
  await gitExec([
    "-C",
    testsRepo,
    "-c",
    "user.name=qa",
    "-c",
    "user.email=qa@example.com",
    "commit",
    "-qm",
    "init",
  ]);
  const yaml = join(p.project, ".qa", "qa.project.yaml");
  await writeFile(
    yaml,
    (await readFile(yaml, "utf8")).replace(
      "repos: { shop: { host: local, path: demo-org/demo-shop } }",
      "repos: { shop: { host: local, path: demo-org/demo-shop }, tests: { host: local, path: demo-org/shop-tests, role: tests } }",
    ),
  );
  const dir = await p.prepare(planDraft);
  await p.run(["run", "DEMO-1", "--build", "--set", "api.BUG_CART_TOTAL_ROUNDING=1"]);
  const branches = async () => (await gitExec(["-C", testsRepo, "branch", "--list"])).stdout;
  return { ...p, dir, branches };
};

describe("promotion cannot be faked (REQ-PUB-08/AC2, invariants 1, 3, 8)", () => {
  it("REQ-PUB-08/AC2: a FAILED result rewritten to look passed is still FAILED: statuses come from the runner record", async () => {
    const p = await setup();
    // Edit run.json's summary of statuses: the verdict is recomputed from results/, so TC-01 stays FAILED.
    const runJson = join(p.dir, "run.json");
    const record = JSON.parse(await readFile(runJson, "utf8")) as {
      data: { results: Record<string, string> };
    };
    record.data.results["TC-01"] = "PASSED";
    await writeFile(runJson, JSON.stringify(record));
    const r = await p.run(["promote", "DEMO-1", "--cases", "TC-01", "--yes"]);
    expect(r.exitCode).toBe(3);
    expect(r.err).toContain("[CASES_NOT_PROMOTABLE]");
    expect(r.err).toContain("TC-01: FAILED");
    expect(await p.branches()).not.toContain("qajitsu/");
  }, 240_000);

  it("invariant 3: a changed approved plan blocks every promotion", async () => {
    const p = await setup();
    const approved = join(p.dir, "plan", "plan.approved.yaml");
    await writeFile(approved, (await readFile(approved, "utf8")).replace("1.01", "9.99"));
    const r = await p.run(["promote", "DEMO-1", "--yes"]);
    expect(r.exitCode).toBe(3);
    expect(r.err).toContain("[PLAN_HASH_MISMATCH]");
    expect(await p.branches()).not.toContain("qajitsu/");
  }, 240_000);

  it("REQ-PUB-08/AC2: a spec swapped after the run together with a forged hash in the results is refused", async () => {
    const p = await setup();
    const spec = join(p.dir, "specs", "TC-02.spec.ts");
    await writeFile(spec, `${await readFile(spec, "utf8")}\n// swapped after the run\n`);
    // Results are runner-only files (invariant 2); rewriting the recorded hash breaks the results' journal trail.
    const resultsFile = join(p.dir, "results", "TC-02.json");
    const results = JSON.parse(await readFile(resultsFile, "utf8")) as {
      attempts: { specSha256?: string }[];
    };
    // The forger even writes the correct hash of the swapped spec.
    const swapped = createHash("sha256")
      .update(await readFile(spec))
      .digest("hex");
    for (const a of results.attempts) a.specSha256 = swapped;
    await writeFile(resultsFile, JSON.stringify(results));
    const r = await p.run(["promote", "DEMO-1", "--yes"]);
    expect(r.exitCode).toBe(3);
    expect(r.err).toContain("[SPEC_CHANGED_SINCE_RUN]");
    expect(await p.branches()).not.toContain("qajitsu/");
  }, 240_000);

  it("invariant 8: a pack that would carry a secret value is never pushed, and the error does not repeat it", async () => {
    const leaky = JSON.parse(draft) as { cases: { title: string }[] };
    const second = leaky.cases[1];
    if (second) second.title = `Second code replaces the first for ${PASSWORD}`;
    const p = await setup(JSON.stringify(leaky));
    const r = await p.run(["promote", "DEMO-1", "--yes"]);
    expect(r.exitCode).toBe(3);
    expect(r.err).toContain("[PROMOTE_GATES_FAILED]");
    expect(r.err).toContain("no-secrets");
    expect(r.err + r.out).not.toContain(PASSWORD);
    expect(await p.branches()).not.toContain("qajitsu/");
  }, 240_000);
});
