import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiService, createBuildProject, draft } from "../../../../tests/support/cli-build.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** TC-01 runs in pl-PL and de-DE; de-DE expects a different total, as a locale with its own format would. */
const setup = async (
  locales = "locales: [{ name: pl-PL, timezone: Europe/Warsaw }, { name: de-DE, timezone: Europe/Berlin }]",
) => {
  const p = await createBuildProject(`${apiService()}\n${locales}`);
  cleanups.push(p.cleanup);
  const plan = JSON.parse(draft) as {
    cases: { locales?: string[]; steps: { expect: Record<string, unknown> }[] }[];
  };
  const tc1 = plan.cases[0];
  if (!tc1?.steps[0]) throw new Error("fixture");
  tc1.locales = ["pl-PL", "de-DE"];
  tc1.steps[0].expect = { ...tc1.steps[0].expect, by_locale: { "de-DE": { fields: { total: 9.99 } } } };
  const dir = await p.prepare(JSON.stringify(plan));
  const data = async () =>
    (
      JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as {
        data: { results: Record<string, string> };
      }
    ).data;
  return { ...p, dir, data };
};

describe("locale runs (REQ-EXEC-14)", () => {
  it("REQ-EXEC-14/AC1+AC2+AC3: a case runs per locale with that locale's expected values from the plan; the matrix shows each", async () => {
    const p = await setup();
    const r = await p.run(["run", "DEMO-1", "--build"]);
    expect(r.exitCode).toBe(1);
    // pl-PL keeps the planned total and passes; de-DE expects 9.99 from the plan and fails: the case is FAILED.
    expect((await p.data()).results).toEqual({ "TC-01": "FAILED", "TC-02": "PASSED" });
    expect((await readdir(join(p.dir, "results", "locale"))).sort()).toEqual(["de-DE", "pl-PL"]);
    const de = await readFile(join(p.dir, "results", "locale", "de-DE", "TC-01.json"), "utf8");
    expect(de).toContain('"expected": 9.99');
    const matrix = await readFile(join(p.dir, "report", "matrix.md"), "utf8");
    expect(matrix).toContain("| Locales |");
    expect(matrix).toMatch(/\| TC-01 \|.*\| FAILED \|.*\| default PASSED, de-DE FAILED, pl-PL PASSED \|/);
    // REQ-EXEC-14/AC1: the API is asked for the locale.
    const manifest = await readFile(join(p.dir, "evidence", "manifest.json"), "utf8");
    const plEvidence = /"path": "(locale\/pl-PL\/TC-01\/attempt-1\/S1-\d+\.json)"/.exec(manifest)?.[1] ?? "";
    expect(await readFile(join(p.dir, "evidence", plEvidence), "utf8")).toContain(
      '"accept-language": "pl-PL"',
    );
  }, 240_000);

  it("REQ-EXEC-14/AC1: a locale the project does not declare makes that run BLOCKED, never PASSED", async () => {
    const p = await setup("locales: [{ name: pl-PL, timezone: Europe/Warsaw }]");
    await p.run(["run", "DEMO-1", "--build"]);
    expect((await p.data()).results["TC-01"]).toBe("BLOCKED");
    expect(await readFile(join(p.dir, "results", "locale", "de-DE", "TC-01.json"), "utf8")).toContain(
      "locale de-DE is not in the project's locales",
    );
  }, 240_000);
});
