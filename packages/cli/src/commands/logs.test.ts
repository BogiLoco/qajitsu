import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline, DEMO_PASSWORD } from "../../../../tests/support/cli-pipeline.js";
import { runLogs } from "./logs.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("qajitsu logs (REQ-OBS-02/AC1)", () => {
  it("REQ-OBS-02/AC1: prints the event log filtered by stage, agent and case", async () => {
    const p = await createDemoPipeline();
    cleanups.push(p.cleanup);
    await p.executed();
    const all = await p.run(["logs", "DEMO-1"]);
    expect(all.exitCode).toBe(0);
    expect(all.out).toContain("fetch    system:orchestrator");
    expect(all.out).toContain("model.usage");
    expect(all.out).not.toContain(DEMO_PASSWORD);
    const run = await p.run(["logs", "DEMO-1", "--stage", "run", "--case", "TC-02"]);
    expect(
      run.out
        .split("\n")
        .filter(Boolean)
        .every((l) => l.includes(" run ") && l.includes('"caseId":"TC-02"')),
    ).toBe(true);
    expect(run.out).toContain("verify");
    const planner = await p.run(["logs", "DEMO-1", "--agent", "planner"]);
    expect(planner.out).toContain("agent:planner");
    expect(planner.out).not.toContain("agent:analyst");
  });

  it("REQ-OBS-02/AC1: --follow polls while the run is running and stops when it ends", async () => {
    const p = await createDemoPipeline();
    cleanups.push(p.cleanup);
    await p.executed();
    const runJson = join(p.runDir, "run.json");
    const record = JSON.parse(await readFile(runJson, "utf8")) as { status: string };
    await writeFile(runJson, JSON.stringify({ ...record, status: "running" }));
    let out = "";
    let polls = 0;
    const code = await runLogs(
      "DEMO-1",
      { follow: true, stage: "publish" },
      { write: (t) => (out += t), writeError: () => undefined, cwd: p.project },
      {
        env: {},
        home: p.home,
        now: () => new Date(),
        random: Math.random,
        fetch: globalThis.fetch,
        gitExec: () => Promise.resolve({ stdout: "", stderr: "" }),
      },
      {
        sleep: async () => {
          polls += 1;
          if (polls === 2) await writeFile(runJson, JSON.stringify({ ...record, status: "completed" }));
        },
      },
    );
    expect(code).toBe(0);
    expect(polls).toBe(2);
    expect(out).toBe("");
  });
});
