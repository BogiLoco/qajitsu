import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AttemptExecutor } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** DEMO-4 has two web cases; the matrix is set before the run. */
const setup = async (
  matrix: string,
  options: { wrapExecutor?: (e: AttemptExecutor) => AttemptExecutor; unavailable?: string[] } = {},
) => {
  const p = await createDemoPipeline({
    ticket: "DEMO-4",
    ...(options.wrapExecutor ? { wrapExecutor: options.wrapExecutor } : {}),
    ports: {
      browserUnavailable: (b) =>
        options.unavailable?.includes(b) ? `${b} is not installed (test)` : undefined,
    },
  });
  cleanups.push(p.cleanup);
  const yaml = join(p.project, ".qa", "qa.project.yaml");
  await writeFile(yaml, `${await readFile(yaml, "utf8")}\nweb: { matrix: ${matrix} }\n`);
  return p;
};
const statuses = async (dir: string) =>
  (JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as { data: { results: Record<string, string> } })
    .data.results;

describe("browser and viewport matrix (REQ-EXEC-13)", () => {
  it("REQ-EXEC-13/AC1+AC2: web cases run in every combination; results, evidence and the matrix show each one", async () => {
    const p = await setup(
      "{ browsers: [chromium], viewports: [{ name: desktop, width: 1280, height: 800 }, { name: mobile, width: 390, height: 844 }] }",
    );
    const r = await p.executed();
    expect(r.exitCode).toBe(0);
    expect(await statuses(p.runDir)).toEqual({ "TC-01": "PASSED", "TC-02": "PASSED" });
    expect((await readdir(join(p.runDir, "results", "matrix", "chromium-mobile"))).sort()).toEqual([
      "TC-01.json",
      "TC-02.json",
    ]);
    expect(await readFile(join(p.runDir, "evidence", "manifest.json"), "utf8")).toContain(
      '"path": "matrix/chromium-mobile/TC-01/attempt-1/',
    );
    const matrix = await readFile(join(p.runDir, "report", "matrix.md"), "utf8");
    expect(matrix).toContain("| Browsers |");
    expect(matrix).toMatch(
      /\| TC-01 \|.*\| PASSED \|.*\| chromium-desktop PASSED, chromium-mobile PASSED \|/,
    );
    expect(await readFile(join(p.runDir, "report", "report.html"), "utf8")).toContain(
      "Browsers: chromium-desktop PASSED, chromium-mobile PASSED",
    );
  }, 240_000);

  it("REQ-EXEC-13/AC2: a case that fails in one combination is FAILED although the primary run passed", async () => {
    let calls = 0;
    const p = await setup(
      "{ browsers: [chromium], viewports: [{ name: desktop, width: 1280, height: 800 }, { name: mobile, width: 390, height: 844 }] }",
      {
        // The first two attempts are the primary run; afterwards TC-01 (the mobile layout) shows a wrong value.
        wrapExecutor: (inner) => async (input) => {
          calls += 1;
          const record = await inner(input);
          if (calls <= 2 || input.caseId !== "TC-01") return record;
          const [first, ...rest] = record.assertions;
          return first
            ? {
                ...record,
                outcome: "failed",
                assertions: [{ ...first, actual: "(wrong on mobile)", pass: false }, ...rest],
              }
            : record;
        },
      },
    );
    const r = await p.executed();
    expect(r.exitCode).toBe(1);
    expect(await statuses(p.runDir)).toEqual({ "TC-01": "FAILED", "TC-02": "PASSED" });
    expect(await readFile(join(p.runDir, "report", "matrix.md"), "utf8")).toMatch(
      /\| TC-01 \|.*\| FAILED \|.*\| chromium-desktop PASSED, chromium-mobile FAILED \|/,
    );
    const preview = await p.run(["publish", "DEMO-4"], { ask: ["n"] });
    expect(preview.out).toContain(
      "Browsers and viewports:\n  TC-01: chromium-desktop PASSED, chromium-mobile FAILED",
    );
  }, 240_000);

  it("REQ-EXEC-13/AC3: a browser that is not installed makes its combinations BLOCKED with the reason; the case is not PASSED", async () => {
    const p = await setup("{ browsers: [chromium, firefox] }", { unavailable: ["firefox"] });
    const r = await p.executed();
    expect(r.exitCode).not.toBe(0);
    expect(await statuses(p.runDir)).toEqual({ "TC-01": "BLOCKED", "TC-02": "BLOCKED" });
    const blocked = await readFile(
      join(p.runDir, "results", "matrix", "firefox-desktop", "TC-01.json"),
      "utf8",
    );
    expect(blocked).toContain("firefox is not installed (test)");
    expect(await readFile(join(p.runDir, "report", "matrix.md"), "utf8")).toContain(
      "chromium-desktop PASSED, firefox-desktop BLOCKED",
    );
  }, 240_000);
});
