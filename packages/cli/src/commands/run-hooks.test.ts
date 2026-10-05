import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_PASSWORD, createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** The demo pipeline with `hooks` in the project config and the given scripts in `.qa/hooks/`. */
const withHooks = async (hooks: string, scripts: Record<string, string>) => {
  const p = await createDemoPipeline();
  cleanups.push(p.cleanup);
  const yaml = join(p.project, ".qa", "qa.project.yaml");
  await writeFile(yaml, `${await readFile(yaml, "utf8")}\nhooks: ${hooks}\n`);
  await mkdir(join(p.project, ".qa", "hooks"), { recursive: true });
  for (const [name, body] of Object.entries(scripts))
    await writeFile(join(p.project, ".qa", "hooks", name), body);
  return p;
};
const trace = (name: string) =>
  `import { appendFileSync } from "node:fs";
appendFileSync(new URL("./trace.txt", import.meta.url), "${name} " + process.env.QAJITSU_RUN + " " + process.env.BASE_URL + "\\n");
console.log("${name} done with ${DEMO_PASSWORD}");`;

describe("setup and teardown hooks of a run (REQ-GEN-01/AC2)", () => {
  it("REQ-GEN-01/AC2: setup runs before the cases and teardown after them, with the run marker; logs are masked", async () => {
    const p = await withHooks("{ setup: hooks/setup.mjs, teardown: hooks/teardown.mjs }", {
      "setup.mjs": trace("setup"),
      "teardown.mjs": trace("teardown"),
    });
    const result = await p.executed();
    expect(result.exitCode).toBe(0);
    const lines = (await readFile(join(p.project, ".qa", "hooks", "trace.txt"), "utf8")).trim().split("\n");
    expect(lines.map((l) => l.split(" ")[0])).toEqual(["setup", "teardown"]);
    expect(lines[0]).toMatch(/^setup 20261003-1046-aaaa http:\/\/127\.0\.0\.1:\d+$/);
    const log = await readFile(join(p.runDir, "logs", "setup.log"), "utf8");
    expect(log).toContain("setup done with");
    expect(log).not.toContain(DEMO_PASSWORD);
    const journal = await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8");
    expect(journal).toContain('"hook.setup"');
    expect(journal).toContain('"hook.teardown"');
  });

  it("REQ-GEN-01/AC2: a failing setup makes every case BLOCKED with its log as evidence; teardown still runs", async () => {
    const p = await withHooks("{ setup: hooks/setup.mjs, teardown: hooks/teardown.mjs }", {
      "setup.mjs": `console.error("cannot reset the data"); process.exit(2);`,
      "teardown.mjs": trace("teardown"),
    });
    const result = await p.executed();
    expect(result.exitCode).toBe(2);
    expect(result.err).toContain("Setup hook hooks/setup.mjs failed");
    expect(result.out).toContain("**2 cases: 2 BLOCKED**");
    const manifest = JSON.parse(await readFile(join(p.runDir, "evidence", "manifest.json"), "utf8")) as {
      path: string;
    }[];
    expect(manifest.map((m) => m.path)).toContain("TC-01/attempt-1/setup.log");
    expect(await readFile(join(p.project, ".qa", "hooks", "trace.txt"), "utf8")).toContain("teardown");
  });

  it("REQ-GEN-01/AC2: a failing teardown is a warning; the statuses stay", async () => {
    const p = await withHooks("{ teardown: hooks/teardown.mjs }", {
      "teardown.mjs": `process.exit(1);`,
    });
    const result = await p.executed();
    expect(result.exitCode).toBe(0);
    expect(result.err).toContain("Warning: teardown hook hooks/teardown.mjs failed");
  });

  it("REQ-GEN-01/AC2: hooks must live in .qa/hooks/", async () => {
    const p = await withHooks("{ setup: ../outside.mjs }", {});
    const result = await p.run(["run", "DEMO-1"]);
    expect(result.exitCode).toBe(3);
    expect(result.err).toContain("hooks.setup");
  });
});
