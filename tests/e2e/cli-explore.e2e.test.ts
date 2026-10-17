// REQ-EXEC-24 dogfooding: `qj explore --cli qj` explores QAJitsu's own built CLI. The inner qj runs for real in a
// sandbox made from the demo shop (its own HOME, the demo git repository, a registered project); the explorer is a
// scripted model, so the run is offline and deterministic.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliExploreSessionSchema } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../support/cli-pipeline.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("qj explore --cli qj (REQ-EXEC-24)", () => {
  it("REQ-EXEC-24/AC1-AC5: the real qj runs in a sandbox from the demo shop; every command is recorded and nothing is left", async () => {
    const p = await createDemoPipeline({ ticket: "DEMO-1" });
    cleanups.push(p.cleanup);
    const yaml = join(p.project, ".qa", "qa.project.yaml");
    await writeFile(
      yaml,
      `${await readFile(yaml, "utf8")}
explore:
  cli:
    qj:
      command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(join(root, "packages/cli/dist/bin.js"))}]
      fixture: ${JSON.stringify(join(root, "examples/demo-shop"))}
      setup:
        - [${JSON.stringify(process.execPath)}, ${JSON.stringify(join(root, "examples/demo-shop/scripts/setup-demo-repo.mjs"))}]
        - { command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(join(root, "packages/cli/dist/bin.js"))}, init, demo-shop, --qa-dir, .qa, --yes], ok_exit_codes: [0, 2] }
      env:
        DEMO_USER_PASSWORD: { secret: secret://env/DEMO_USER_PASSWORD }
      timeout_s: 120
`,
    );
    expect((await p.run(["fetch", "DEMO-1"])).exitCode).toBe(0);
    const result = await p.run(
      [
        "explore",
        "DEMO-1",
        "--cli",
        "qj",
        "--goal",
        "Check the basics of qj in a fresh project",
        "--max-steps",
        "10",
      ],
      {
        script: [
          { tools: [{ name: "cli_run", input: { args: ["--version"] } }] },
          { tools: [{ name: "cli_run", input: { args: ["status"] } }] },
          { tools: [{ name: "cli_run", input: { args: ["fetch", "DEMO-1"] } }] },
          { tools: [{ name: "cli_run", input: { args: ["runs", "DEMO-1"] } }] },
          { tools: [{ name: "cli_run", input: { args: ["approve", "DEMO-1"] } }] },
          { tools: [{ name: "cli_leftovers", input: {} }] },
          {
            tools: [
              {
                name: "record_observation",
                input: {
                  title: "approve without a plan explains what to do",
                  kind: "ux",
                  severity: "low",
                  description: "approve before plan stops with an error code.",
                  steps: ["A03", "A05"],
                  expected: "a clear error",
                  actual: "see the output",
                },
              },
            ],
          },
          { text: JSON.stringify({ summary: "qj basics in a fresh project." }) },
        ],
      },
    );
    expect(result.err).toBe("");
    expect(result.exitCode).toBe(0);
    const session = CliExploreSessionSchema.parse(
      JSON.parse(await readFile(join(p.runDir, "explore", "S01", "session.json"), "utf8")),
    );
    expect(session.actions.map((a) => [a.args.join(" "), a.exitCode ?? null])).toEqual([
      ["--version", 0],
      ["status", 0],
      ["fetch DEMO-1", 0],
      ["runs DEMO-1", 0],
      ["approve DEMO-1", 3],
      ["", null],
    ]);
    const output = (id: string) =>
      readFile(join(p.runDir, "explore", "S01", "evidence", `${id}-output.txt`), "utf8");
    expect(await output("A02")).toContain("demo-shop");
    expect(await output("A03")).toContain("Context written to");
    expect(await output("A05")).toMatch(/PLAN_NOT_FOUND|no plan|not planned/i);
    expect(session.leftovers).toEqual({ processes: [], containers: [] });
    expect(session.observations.map((o) => o.id)).toEqual(["O1"]);
    // The person's own QAJitsu home was never touched: the inner qj used the sandbox's HOME.
    expect(await readFile(join(p.runDir, "explore", "S01", "evidence", "setup-2.txt"), "utf8")).toContain(
      "demo-shop",
    );
  });
});
