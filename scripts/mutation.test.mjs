import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MUTATED, unexplainedExclusions } from "./mutation.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");
const config = (p) => JSON.parse(read(`stryker/${p}.config.json`));
const job = () => parse(read(".github/workflows/ci.yml")).jobs.mutation;

describe("mutation testing of the trust-critical packages (REQ-NFR-14)", () => {
  it("REQ-NFR-14/AC1: guard, verifier and steps are mutated and checked by their own tests", () => {
    expect(MUTATED).toEqual(["guard", "verifier", "steps"]);
    for (const p of MUTATED) {
      const c = config(p);
      expect(c.mutate).toEqual([`packages/${p}/src/**/*.ts`, `!packages/${p}/src/**/*.test.ts`]);
      expect(c.testRunner).toBe("vitest");
      expect(c.vitest).toEqual({ configFile: "vitest.mutation.config.ts", dir: `packages/${p}` });
      // Type checks are switched off only in the mutated package: the verifier type-checks specs against steps.
      expect(c.disableTypeChecks).toBe(`packages/${p}/src/**/*.ts`);
    }
    expect(read("package.json")).toContain('"mutation": "node scripts/mutation.mjs"');
  });

  it("REQ-NFR-14/AC1: CI runs it nightly and on demand, never on a pull request", () => {
    const ci = parse(read(".github/workflows/ci.yml"));
    expect(ci.on.schedule?.length).toBeGreaterThan(0);
    expect(ci.on).toHaveProperty("workflow_dispatch");
    expect(job().if).toBe("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
    expect(job().strategy.matrix.package).toEqual(MUTATED);
    expect(
      job()
        .steps.map((s) => s.run)
        .filter(Boolean),
    ).toContain("pnpm mutation ${{ matrix.package }}");
  });

  it("REQ-NFR-14/AC2: every package fails below its own mutation score threshold", () => {
    for (const p of MUTATED) {
      const { thresholds } = config(p);
      expect(typeof thresholds.break, p).toBe("number");
      expect(thresholds.break, p).toBeGreaterThan(0);
    }
  });

  it("REQ-NFR-14/AC3: the HTML and JSON reports are written per package and kept as CI artifacts", () => {
    for (const p of MUTATED) {
      const c = config(p);
      expect(c.reporters).toEqual(expect.arrayContaining(["html", "json"]));
      expect(c.htmlReporter.fileName).toBe(`reports/mutation/${p}/index.html`);
      expect(c.jsonReporter.fileName).toBe(`reports/mutation/${p}/mutation.json`);
    }
    const upload = job().steps.find((s) => String(s.uses).startsWith("actions/upload-artifact@"));
    expect(upload.if).toBe("always()");
    expect(upload.with.path).toBe("reports/mutation/${{ matrix.package }}/");
  });

  it("REQ-NFR-14/AC4: an exclusion says why the mutant cannot change behaviour; one without a reason is refused", () => {
    const text = [
      "// Stryker disable next-line StringLiteral: the message is only shown, the code decides",
      "const a = 1; // Stryker disable next-line all",
      "/* Stryker disable EqualityOperator: same */",
      "// Stryker restore all",
      "/* Stryker disable all: generated table, checked by its own golden test */",
    ].join("\n");
    expect(unexplainedExclusions("x.ts", text)).toEqual([
      'x.ts:2: a Stryker exclusion needs ": <why the mutant cannot change behaviour>"',
      'x.ts:3: a Stryker exclusion needs ": <why the mutant cannot change behaviour>"',
    ]);
  });

  it("REQ-NFR-14/AC4: every exclusion in the mutated sources states its reason", () => {
    const sources = (dir) =>
      readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
      );
    const problems = MUTATED.flatMap((p) =>
      sources(`packages/${p}/src`).flatMap((f) => unexplainedExclusions(f, read(f))),
    );
    expect(problems).toEqual([]);
  });

  it("REQ-NFR-14/AC5: the mutation tools are pinned development dependencies without install scripts", () => {
    const pkg = JSON.parse(read("package.json"));
    const tools = ["@stryker-mutator/core", "@stryker-mutator/vitest-runner"];
    for (const t of tools) {
      expect(pkg.devDependencies[t], t).toMatch(/^\d+\.\d+\.\d+$/);
      expect(pkg.dependencies?.[t], t).toBeUndefined();
    }
    const lock = parse(read("pnpm-lock.yaml"));
    const stryker = Object.entries(lock.packages).filter(([k]) => k.startsWith("@stryker-mutator/"));
    expect(stryker.length).toBeGreaterThanOrEqual(tools.length);
    for (const [k, v] of stryker) expect(v.requiresBuild, k).toBeUndefined();
  });
});
