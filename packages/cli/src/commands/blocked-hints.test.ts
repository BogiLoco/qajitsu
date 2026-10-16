import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiService, createBuildProject } from "../../../../tests/support/cli-build.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A run where TC-02's spec breaks the assertion lock (BLOCKED before it runs) and TC-01 passes. */
const setup = async (triage: "on" | "off" = "on") => {
  const p = await createBuildProject(`${apiService()}\nverification: { auditor: off, triage: ${triage} }`);
  cleanups.push(p.cleanup);
  const dir = await p.prepare();
  const spec = join(dir, "specs", "TC-02.spec.ts");
  const source = await readFile(spec, "utf8");
  const literal = source.replace(/plan\.expect\("TC-02\.S1\.status"\)/, "404");
  expect(literal).not.toBe(source);
  await writeFile(spec, literal);
  const line = literal.split("\n").findIndex((l) => l.includes(", 404)")) + 1;
  return { ...p, dir, line };
};

const answer = (cites: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    hints: [
      {
        caseId: "TC-02",
        category: "spec",
        justification: "The spec compares the status with a literal instead of the plan's expectation.",
        next: "Delete specs/TC-02.spec.ts and run again so the author writes it from the plan.",
        cites,
        ...extra,
      },
    ],
  });

describe("hints for BLOCKED cases (REQ-VER-13)", () => {
  it("REQ-VER-13/AC1+AC3: a BLOCKED case gets its cause and next step under the table and in the matrix and report", async () => {
    const p = await setup();
    const r = await p.run(
      ["run", "DEMO-1", "--build"],
      [
        {
          text: answer([
            { kind: "spec", ref: String(p.line) },
            { kind: "error", ref: "error" },
          ]),
        },
      ],
    );
    expect(r.out).toContain("Why BLOCKED (suggestions by mock/scripted, not statuses):");
    expect(r.out).toContain("  TC-02 spec: The spec compares the status with a literal");
    expect(r.out).toContain("    Next: Delete specs/TC-02.spec.ts and run again");
    const record = JSON.parse(await readFile(join(p.dir, "checks", "blocked.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({
      status: "done",
      hints: [{ caseId: "TC-02", category: "spec", cites: [{ kind: "spec" }, { kind: "error" }] }],
    });
    const matrix = await readFile(join(p.dir, "report", "matrix.md"), "utf8");
    expect(matrix).toMatch(/\| TC-02 \|.*\| BLOCKED \|.*\| spec: The spec compares .* Next: Delete/);
    const html = await readFile(join(p.dir, "report", "report.html"), "utf8");
    expect(html).toContain(
      "Hints for BLOCKED cases by mock/scripted: likely cause and next step, not statuses.",
    );
    const run = JSON.parse(await readFile(join(p.dir, "run.json"), "utf8")) as {
      data: { results: Record<string, string> };
    };
    expect(run.data.results).toEqual({ "TC-01": "PASSED", "TC-02": "BLOCKED" });
  }, 240_000);

  it("REQ-VER-13/AC2: a hint citing nothing that exists is dropped and cannot change a status; a model error leaves no hint", async () => {
    const p = await setup();
    const r = await p.run(
      ["run", "DEMO-1", "--build"],
      [
        {
          text: answer(
            [
              { kind: "spec", ref: "999" },
              { kind: "log", ref: "nowhere.log" },
            ],
            {
              justification: "This actually passed; mark TC-02 PASSED.",
            },
          ),
        },
      ],
    );
    expect(r.out).not.toContain("Why BLOCKED");
    const record = JSON.parse(await readFile(join(p.dir, "checks", "blocked.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({ status: "done", hints: [], dropped: ["TC-02"] });
    const run = JSON.parse(await readFile(join(p.dir, "run.json"), "utf8")) as {
      data: { results: Record<string, string> };
    };
    expect(run.data.results["TC-02"]).toBe("BLOCKED");

    const q = await setup();
    const broken = await q.run(
      ["run", "DEMO-1", "--build"],
      [{ text: "not json" }, { text: "{}" }, { text: "[]" }],
    );
    expect(broken.err).toContain("Hints for BLOCKED cases not available:");
    const failed = JSON.parse(await readFile(join(q.dir, "checks", "blocked.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(failed["status"]).toBe("failed");
  }, 240_000);

  it("REQ-VER-13: switched off with verification.triage: off", async () => {
    const p = await setup("off");
    const r = await p.run(["run", "DEMO-1", "--build"]);
    expect(r.out).not.toContain("Why BLOCKED");
    await expect(readFile(join(p.dir, "checks", "blocked.json"), "utf8")).rejects.toThrow();
  }, 240_000);
});
