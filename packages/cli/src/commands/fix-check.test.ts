import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildProject } from "../../../../tests/support/cli-build.js";
import { gitExec } from "../../../../tests/support/cli-project.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const BUG_LINE = 'BUG_FLAGS.map((f) => [f, env[f] === "1" || env[f] === "true"])';
const FORCED =
  'BUG_FLAGS.map((f) => [f, f === "BUG_CART_TOTAL_ROUNDING" || env[f] === "1" || env[f] === "true"])';

/**
 * Rewrites the demo repository: `main` gets a commit with the rounding bug hard-coded (the version before the fix),
 * and the DEMO-1 branch starts from it with one commit that removes the bug (the fix) or does not.
 */
const history = async (home: string, options: { bugInBase: boolean; fixFixes: boolean }) => {
  const repo = join(home, "git", "demo-org", "demo-shop");
  const g = (...args: string[]) =>
    gitExec(["-C", repo, "-c", "user.name=qa", "-c", "user.email=qa@example.com", ...args]);
  const server = join(repo, "api", "server.mjs");
  const clean = await readFile(server, "utf8");
  expect(clean).toContain(BUG_LINE);
  await g("checkout", "-q", "main");
  if (options.bugInBase) {
    await writeFile(server, clean.replace(BUG_LINE, FORCED));
    await g("commit", "-qam", "cart total rounded per line");
  }
  await g("checkout", "-q", "-B", "feature/DEMO-1-cart-discounts", "main");
  await writeFile(join(repo, "cart.ts"), "export const v = 2;\n");
  if (options.fixFixes) await writeFile(server, clean);
  await g("commit", "-qam", "DEMO-1 round the cart total once");
  await g("checkout", "-q", "main");
};

const reproducing = async () => {
  const draft = JSON.parse(
    await readFile(new URL("../../../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8"),
  ) as { cases: Record<string, unknown>[] };
  return JSON.stringify({
    ...draft,
    cases: draft.cases.map((c, i) => (i === 0 ? { ...c, reproduces: true } : c)),
  });
};

const setup = async (options: { bugInBase: boolean; fixFixes: boolean }) => {
  const p = await createBuildProject();
  cleanups.push(p.cleanup);
  await history(p.home, options);
  const dir = await p.prepare(await reproducing());
  return { ...p, dir };
};
const runJson = async (dir: string) =>
  JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as {
    data: Record<string, unknown> & { results?: Record<string, string>; approval?: { sha256: string } };
  };

describe("qajitsu run --fix-check (REQ-VER-11)", () => {
  it("REQ-VER-11/AC1+AC2+AC3+AC4: the reproduction case fails before the fix and passes with it; both runs use the same plan and spec", async () => {
    const { run, dir, home } = await setup({ bugInBase: true, fixFixes: true });
    const result = await run(["run", "DEMO-1", "--build", "--fix-check"]);
    expect(result.err).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain("Fix VERIFIED");
    expect(result.out).toContain("TC-01: FAILED → PASSED · failed before the fix and passed with it");
    const fix = await runJson(dir);
    const check = fix.data["fixCheck"] as {
      verified: boolean;
      baseRun: string;
      baseSha: string;
      fixSha: string;
      cases: { caseId: string; specBefore: string; specAfter: string }[];
    };
    expect(check.verified).toBe(true);
    expect(check.baseSha).not.toBe(check.fixSha);
    expect(check.cases[0]?.specBefore).toBe(check.cases[0]?.specAfter);
    // The run before the fix is a full run of its own: approved with the same plan bytes, own results and evidence.
    const baseDir = join(home, "runs", "DEMO-1", check.baseRun);
    const base = await runJson(baseDir);
    expect(base.data.approval?.sha256).toBe(fix.data.approval?.sha256);
    expect(base.data.results?.["TC-01"]).toBe("FAILED");
    expect(base.data["fixCheckOf"]).toBe(dir.split("/").at(-1));
    expect(await readdir(join(baseDir, "evidence"))).toContain("manifest.json");
    const report = await readFile(join(dir, "report", "report.html"), "utf8");
    expect(report).toContain('Fix verification: <span class="ok">verified</span>');
    expect(report).toContain(`../../${check.baseRun}/report/report.html#TC-01`);
  }, 300_000);

  it("REQ-VER-11/AC3: a fix that does not fix the bug is not verified (exit code 1)", async () => {
    const { run } = await setup({ bugInBase: true, fixFixes: false });
    const result = await run(["run", "DEMO-1", "--build", "--fix-check"]);
    expect(result.exitCode).toBe(1);
    expect(result.out).toContain("Fix NOT verified");
    expect(result.out).toContain("TC-01: FAILED → FAILED · still FAILED with the fix");
  }, 300_000);

  it("REQ-VER-11/AC3: a test that passes before the fix does not reproduce the bug (exit code 2)", async () => {
    const { run } = await setup({ bugInBase: false, fixFixes: true });
    const result = await run(["run", "DEMO-1", "--build", "--fix-check"]);
    expect(result.exitCode).toBe(2);
    expect(result.out).toContain(
      "TC-01: PASSED → PASSED · passed before the fix: the test does not reproduce the bug",
    );
  }, 300_000);

  it("REQ-VER-11/AC1: needs --build and a case marked reproduces", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    await history(p.home, { bugInBase: true, fixFixes: true });
    await p.prepare();
    const noRepro = await p.run(["run", "DEMO-1", "--build", "--fix-check"]);
    expect(noRepro.exitCode).toBe(3);
    expect(noRepro.err).toContain("FIX_CHECK_NO_REPRODUCTION");
    const noBuild = await p.run(["run", "DEMO-1", "--fix-check"]);
    expect(noBuild.err).toContain("FIX_CHECK_NEEDS_BUILD");
  }, 300_000);
});
