import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEventLines } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createBuildProject } from "../../../../tests/support/cli-build.js";
import { gitExec } from "../../../../tests/support/cli-project.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A project with a tests repository and a run of DEMO-1 with BUG-01 on: TC-01 FAILED, TC-02 PASSED. */
const setup = async (options: { testsRepo?: boolean } = {}) => {
  const p = await createBuildProject();
  cleanups.push(p.cleanup);
  const testsRepo = join(p.home, "git", "demo-org", "shop-tests");
  if (options.testsRepo !== false) {
    const g = (...args: string[]) =>
      gitExec(["-C", testsRepo, "-c", "user.name=qa", "-c", "user.email=qa@example.com", ...args]);
    await gitExec(["init", "-q", "-b", "main", testsRepo]);
    await mkdir(join(testsRepo, "tests"));
    await writeFile(join(testsRepo, "tests", "cart.spec.ts"), 'test("cart opens", () => {});\n');
    await g("add", ".");
    await g("commit", "-qm", "init");
    const yaml = join(p.project, ".qa", "qa.project.yaml");
    await writeFile(
      yaml,
      (await readFile(yaml, "utf8")).replace(
        "repos: { shop: { host: local, path: demo-org/demo-shop } }",
        "repos: { shop: { host: local, path: demo-org/demo-shop }, tests: { host: local, path: demo-org/shop-tests, role: tests } }",
      ),
    );
  }
  const dir = await p.prepare();
  expect((await p.run(["run", "DEMO-1", "--build", "--set", "api.BUG_CART_TOTAL_ROUNDING=1"])).exitCode).toBe(
    1,
  );
  const runId = dir.split("/").at(-1) ?? "";
  const branch = `qajitsu/demo-1-${runId}`;
  const show = (path: string) =>
    gitExec(["-C", testsRepo, "show", `${branch}:${path}`]).then((r) => r.stdout);
  const branches = async () => (await gitExec(["-C", testsRepo, "branch", "--list"])).stdout;
  return { ...p, dir, runId, branch, show, branches, testsRepo };
};

describe("qj promote (REQ-PUB-08, REQ-CTX-06/AC4)", () => {
  it("REQ-PUB-08/AC1+AC3 + REQ-CTX-06/AC4: pushes a branch with the PASSED specs unchanged and the plan's expectations", async () => {
    const p = await setup();
    const promoted = await p.run(["promote", "DEMO-1", "--yes"], undefined, {});
    expect(promoted.err).toBe("");
    expect(promoted.exitCode).toBe(0);
    expect(promoted.out).toContain(
      `Promote to demo-org/shop-tests (tests) on branch ${p.branch}, main as target:`,
    );
    expect(promoted.out).toContain("tests/qajitsu/DEMO-1/TC-02.qajitsu.ts");
    expect(promoted.out).toContain("Not promoted (not PASSED): TC-01: FAILED");
    expect(promoted.out).toContain(`Pushed branch ${p.branch}; this code host has no pull requests`);
    // The spec is byte for byte the one that passed; the convention folder of the repository is used.
    expect(await p.show("tests/qajitsu/DEMO-1/TC-02.qajitsu.ts")).toBe(
      await readFile(join(p.dir, "specs", "TC-02.spec.ts"), "utf8"),
    );
    await expect(p.show("tests/qajitsu/DEMO-1/TC-01.qajitsu.ts")).rejects.toThrow();
    const pack = parse(await p.show("tests/qajitsu/DEMO-1/expectations.yaml")) as {
      ticket: string;
      run: string;
      plan: { sha256: string; approved_by: string };
      cases: { id: string; steps: unknown[] }[];
      specs: Record<string, string>;
    };
    const run = JSON.parse(await readFile(join(p.dir, "run.json"), "utf8")) as {
      data: { approval: { sha256: string }; promotions: { branch: string; cases: string[] }[] };
    };
    expect(pack).toMatchObject({
      ticket: "DEMO-1",
      run: p.runId,
      plan: { sha256: run.data.approval.sha256 },
    });
    expect(pack.cases.map((c) => c.id)).toEqual(["TC-02"]);
    expect(Object.keys(pack.specs)).toEqual(["TC-02"]);
    expect(await p.show("tests/qajitsu/DEMO-1/README.md")).toContain("Do not edit expected values here");
    const log = (await gitExec(["-C", p.testsRepo, "log", "-1", "--format=%an%n%B", p.branch])).stdout;
    expect(log).toContain("QAJitsu");
    expect(log).toContain("test(DEMO-1): promote TC-02 from QAJitsu");
    expect(log).toContain("Promoted-by: qa-lead");
    // The main branch of the tests repository is untouched; the promotion is recorded and journaled.
    expect((await gitExec(["-C", p.testsRepo, "ls-tree", "-r", "--name-only", "main"])).stdout).not.toContain(
      "qajitsu",
    );
    expect(run.data.promotions).toMatchObject([{ branch: p.branch, cases: ["TC-02"] }]);
    const events = parseEventLines(await readFile(join(p.dir, "journal", "events.jsonl"), "utf8"));
    expect(events.events.find((e) => e.event === "cases.promoted")).toMatchObject({
      actor: { kind: "user", name: "qa-lead" },
    });
  }, 240_000);

  it("REQ-PUB-08/AC4: nothing is pushed without confirmation; --dry-run writes the pack to exports", async () => {
    const p = await setup();
    const quiet = await p.run(["promote", "DEMO-1"]);
    expect(quiet.exitCode).toBe(2);
    expect(quiet.err).toContain("Not interactive: nothing pushed; confirm with --yes.");
    expect((await p.run(["promote", "DEMO-1"], undefined, { ask: ["no"] })).exitCode).toBe(2);
    expect(await p.branches()).not.toContain("qajitsu/");
    const dry = await p.run(["promote", "DEMO-1", "--dry-run"]);
    expect(dry.exitCode).toBe(0);
    const out = join(p.home, ".qajitsu", "projects", "demo", "exports", "DEMO-1", "promote", p.runId);
    expect(dry.out).toContain(`Dry run: nothing pushed; the pack is in ${out}`);
    expect((await readdir(join(out, "tests", "qajitsu", "DEMO-1"))).sort()).toEqual([
      "README.md",
      "TC-02.qajitsu.ts",
      "expectations.yaml",
    ]);
    expect(await p.branches()).not.toContain("qajitsu/");
    expect((await p.run(["promote", "DEMO-1"], undefined, { ask: ["yes"] })).exitCode).toBe(0);
    expect(await p.branches()).toContain(p.branch);
    // Promoting the same run again updates its branch.
    const again = await p.run(["promote", "DEMO-1", "--yes"]);
    expect(again.err).toBe("");
    expect(again.exitCode).toBe(0);
    // A colleague pushes a fix to the branch: QAJitsu never overwrites it.
    const colleague = join(p.home, "colleague");
    await gitExec(["clone", "-q", "--branch", p.branch, p.testsRepo, colleague]);
    await writeFile(join(colleague, "fix.txt"), "fix\n");
    await gitExec(["-C", colleague, "add", "."]);
    await gitExec([
      "-C",
      colleague,
      "-c",
      "user.name=dev",
      "-c",
      "user.email=dev@example.com",
      "commit",
      "-qm",
      "fix",
    ]);
    await gitExec(["-C", colleague, "push", "-q", "origin", p.branch]);
    const blocked = await p.run(["promote", "DEMO-1", "--yes"]);
    expect(blocked.exitCode).toBe(3);
    expect(blocked.err).toContain("[PROMOTE_BRANCH_CHANGED]");
    expect(await p.show("fix.txt")).toBe("fix\n");
  }, 240_000);

  it("REQ-PUB-08/AC2: only PASSED cases of the approved plan, with the spec that passed, can be promoted", async () => {
    const p = await setup();
    const failed = await p.run(["promote", "DEMO-1", "--cases", "TC-01,TC-02", "--yes"]);
    expect(failed.exitCode).toBe(3);
    expect(failed.err).toContain("[CASES_NOT_PROMOTABLE]");
    expect(failed.err).toContain("TC-01: FAILED");
    expect((await p.run(["promote", "DEMO-1", "--cases", "TC-09", "--yes"])).err).toContain(
      "TC-09: not in the approved plan",
    );
    // A spec edited after the run is not the spec that passed.
    await writeFile(
      join(p.dir, "specs", "TC-02.spec.ts"),
      `${await readFile(join(p.dir, "specs", "TC-02.spec.ts"), "utf8")}\n// edited\n`,
    );
    const changed = await p.run(["promote", "DEMO-1", "--yes"]);
    expect(changed.err).toContain("[SPEC_CHANGED_SINCE_RUN]");
    expect(await p.branches()).not.toContain("qajitsu/");
  }, 240_000);

  it("REQ-PUB-08/AC1: a project without a tests repository is told how to declare one", async () => {
    const p = await setup({ testsRepo: false });
    const r = await p.run(["promote", "DEMO-1", "--yes"]);
    expect(r.exitCode).toBe(3);
    expect(r.err).toContain("[TESTS_REPO_REQUIRED]");
    expect(r.err).toContain("repos.<alias>.role: tests");
  }, 240_000);
});
