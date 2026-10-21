import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { promptOf } from "../../../../tests/support/mock-model.js";
import { createDemoPipeline, flowScript } from "../../../../tests/support/cli-pipeline.js";
import { createBuildProject } from "../../../../tests/support/cli-build.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const withAccess = async (level: "metadata" | "none") => {
  const p = await createDemoPipeline({ config: [`code: { access: ${level} }`] });
  cleanups.push(p.cleanup);
  const fetched = await p.run(["fetch", "DEMO-1"]);
  const record = JSON.parse(await readFile(join(p.runDir, "run.json"), "utf8")) as {
    repos: Record<string, unknown>;
    data: { codeAccess: { level: string; changes: { repo: string; sha: string }[] } };
  };
  return { p, fetched, record, files: await readdir(join(p.runDir, "repos")) };
};

describe("code access levels (REQ-CTX-10)", () => {
  it("REQ-CTX-10/AC1+AC2: metadata keeps the change's title, description and file names; no worktree, diff or review comment is stored", async () => {
    const { p, fetched, record, files } = await withAccess("metadata");
    expect(fetched.exitCode).toBe(0);
    expect(fetched.out).toMatch(
      / {2}shop: branch .* @ [0-9a-f]{12} \(description and file names only, no code\)/,
    );
    expect(files.sort()).toEqual(["changes.json", "shop.meta.json"]);
    expect(record.repos).toEqual({});
    expect(record.data.codeAccess.level).toBe("metadata");
    expect(record.data.codeAccess.changes.map((c) => c.repo)).toEqual(["shop"]);
    const meta = JSON.parse(await readFile(join(p.runDir, "repos", "shop.meta.json"), "utf8")) as {
      change: Record<string, unknown>;
      files: string[];
    };
    expect(meta.files.length).toBeGreaterThan(0);
    expect(Object.keys(meta)).toEqual(["change", "files"]);
    expect(JSON.stringify(meta)).not.toMatch(/@@ |\+\+\+ |comments/);
    // The planner hears it: metadata, no diff to cite.
    const [analysis, draft] = flowScript("DEMO-1");
    const planned = await p.run(["plan", "DEMO-1"], { script: [analysis as never, draft as never] });
    expect(planned.exitCode).toBe(0);
    const prompt = promptOf(planned.model, 0);
    expect(prompt).toContain("Code access: metadata only");
    expect(prompt).toContain(meta.files[0] ?? "x");
    expect(prompt).not.toContain("Diff:");
  }, 120_000);

  it("REQ-CTX-10/AC1+AC2: none reads nothing from the code hosts", async () => {
    const { fetched, record, files } = await withAccess("none");
    expect(fetched.exitCode).toBe(0);
    expect(fetched.out).toContain(
      "Code access: none: nothing was read from the code hosts; plan from the ticket and the environment.",
    );
    expect(files).toEqual(["changes.json"]);
    expect(record.repos).toEqual({});
    expect(record.data.codeAccess).toEqual({ level: "none", changes: [] });
  }, 120_000);

  it("REQ-CTX-10/AC3+AC4: --build says it needs the code; the report header says what was shared", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    const yaml = join(p.project, ".qa", "qa.project.yaml");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(yaml, `${await readFile(yaml, "utf8")}\ncode: { access: none }\n`);
    await p.prepare();
    const refused = await p.run(["run", "DEMO-1", "--build"]);
    expect(refused.err).toContain(
      "Error [CODE_ACCESS_REQUIRED]: --build builds the application from its code, but this project shares no code (code.access: none). Test a provided environment with --env instead.",
    );
  }, 120_000);

  it("REQ-CTX-10/AC4: a run against a provided environment works without code; its report says what was shared", async () => {
    const p = await createDemoPipeline({ config: ["code: { access: metadata }"] });
    cleanups.push(p.cleanup);
    const r = await p.executed();
    expect(r.out).toContain("2 PASSED");
    const html = await readFile(join(p.runDir, "report", "report.html"), "utf8");
    expect(html).toMatch(
      /Code: – \(metadata only, no code \(code\.access: metadata\): shop @ [0-9a-f]{12}\)/,
    );
  }, 180_000);
});
