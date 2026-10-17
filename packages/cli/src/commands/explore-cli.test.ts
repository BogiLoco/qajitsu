import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
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
  {
    text: JSON.stringify({
      checklist: [
        { item: "every subcommand", actions: ["A01", "A02", "A03", "A05", "A06", "A07", "A09"] },
        { item: "what is left running", actions: ["A10"] },
      ],
      findings: [{ text: "orphan leaves a process running", actions: ["A05", "A10"] }],
      summary: "Explored the tool; one process leaked.",
    }),
  },
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
    // REQ-EXEC-24/AC9: one line per action as it ends and each observation, live in the terminal.
    expect(result.out).toContain("A01  tool hello $(whoami) → exit code 0 (");
    expect(result.out).toContain("A03  tool serve &  (B1) → still running (B1) (");
    expect(result.out).toContain("● O1 [medium] orphan leaves a process running after the command ended");
    expect(result.out).not.toContain(DEMO_PASSWORD);
    // REQ-EXEC-24/AC11: the terminal is recorded, in the manifest, and shown in the report.
    expect(session.recordings).toEqual(["recordings/terminal.cast", "recordings/terminal.txt"]);
    expect(manifest.map((m) => m.path)).toEqual(expect.arrayContaining(session.recordings));
    const transcript = await readFile(join(dir, "evidence", "recordings", "terminal.txt"), "utf8");
    expect(transcript).toContain("$ tool hello $(whoami)\nhello $(whoami)\n→ exit code 0");
    expect(transcript).toContain("[B1] listening; press Ctrl+C to stop\n");
    expect(transcript).toContain("(Ctrl+C → B1)\n[B1] stopped\n");
    expect(transcript).not.toContain(DEMO_PASSWORD);
    const cast = (await readFile(join(dir, "evidence", "recordings", "terminal.cast"), "utf8")).split("\n");
    expect(JSON.parse(cast[0] ?? "")).toMatchObject({ version: 2 });
    expect(html).toContain('<pre class="term">');
    expect(html).toContain("asciinema play evidence/recordings/terminal.cast");
    expect(md).toContain("## Terminal");
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
    const claim = {
      text: JSON.stringify({
        checklist: [{ item: "every command", actions: ["A01"] }],
        summary: "Tested every command; all exit codes fit.",
      }),
    };
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

  it("REQ-EXEC-15/AC5 + REQ-EXEC-24/AC1 + REQ-EXEC-25/AC5: the step budget is enforced by code; unanswered checks are not reached", async () => {
    const p = await project();
    const looping: Turn[] = [{ tools: [{ name: "cli_run", input: { args: ["hello"] } }] }];
    const r = await p.run(
      [
        "explore",
        "DEMO-4",
        "--cli",
        "tool",
        "--goal",
        "Loop",
        "--max-steps",
        "2",
        "--check",
        "hello",
        "--check",
        "fail",
      ],
      { script: looping },
    );
    expect(r.exitCode).toBe(0);
    const session = CliExploreSessionSchema.parse(
      JSON.parse(await readFile(join(p.runDir, "explore", "S01", "session.json"), "utf8")),
    );
    expect(session.endReason).toBe("step-budget");
    expect(session.actions).toHaveLength(2);
    // Two hello commands ran, but no answer said which item they did: nothing counts as done.
    expect(session.checklist).toEqual([
      { item: "hello", source: "person", actions: [], notDone: "not reached: the step budget was used" },
      { item: "fail", source: "person", actions: [], notDone: "not reached: the step budget was used" },
    ]);
    expect(r.out).toContain("Checklist: 0 of 2 item(s) done");
  }, 120_000);

  it("REQ-EXEC-25/AC1-AC3+AC5+AC6: the --check checklist comes back complete; undone items are sent back once, then kept with the reason", async () => {
    const p = await project();
    const answer = (checklist: unknown[]) => ({
      text: JSON.stringify({
        checklist,
        findings: [{ text: "fail exits 2 with boom", actions: ["A02"] }],
        summary: "hello and fail behave as written.",
      }),
    });
    const r = await p.run(
      [
        "explore",
        "DEMO-4",
        "--cli",
        "tool",
        "--goal",
        "Basics",
        "--check",
        "hello",
        "--check",
        "fail",
        "--check",
        "the network",
      ],
      {
        script: [
          { tools: [{ name: "cli_run", input: { args: ["hello"] } }] },
          { tools: [{ name: "cli_run", input: { args: ["fail"] } }] },
          // Drops an item: rejected.
          answer([
            { item: "hello", actions: ["A01"] },
            { item: "fail", actions: ["A02"] },
          ]),
          // Leaves one undone while the budget lasts: sent back once.
          answer([
            { item: "hello", actions: ["A01"] },
            { item: "fail", actions: ["A02"] },
            { item: "network", not_done: "the sandbox allows no host" },
          ]),
          answer([
            { item: "hello", actions: ["A01"] },
            { item: "fail", actions: ["A02"] },
            { item: "network", not_done: "the sandbox allows no host" },
          ]),
        ],
      },
    );
    expect(r.err).toBe("");
    const dir = join(p.runDir, "explore", "S01");
    const session = CliExploreSessionSchema.parse(
      JSON.parse(await readFile(join(dir, "session.json"), "utf8")),
    );
    expect(session.endReason).toBe("finished");
    expect(session.checklist).toEqual([
      { item: "hello", source: "person", actions: ["A01"] },
      { item: "fail", source: "person", actions: ["A02"] },
      // The person's text is kept, not the explorer's rewording.
      { item: "the network", source: "person", actions: [], notDone: "the sandbox allows no host" },
    ]);
    expect(session.findings).toEqual([{ text: "fail exits 2 with boom", actions: ["A02"] }]);
    expect(r.out).toContain(
      'Checklist: 2 of 3 item(s) done; not done: "the network" (the sandbox allows no host).',
    );
    const md = await readFile(join(dir, "report.md"), "utf8");
    expect(md).toContain("Items from the person (--check).");
    expect(md).toContain("| 3 | the network | **not done**: the sandbox allows no host |");
    expect(md).toContain("- fail exits 2 with boom (A02 `");
    expect(md.indexOf("## Checklist")).toBeLessThan(md.indexOf("## Explorer's comment"));
    const html = await readFile(join(dir, "report.html"), "utf8");
    expect(html).toContain('<a href="#A02">A02</a>');
  }, 120_000);

  it("REQ-EXEC-25/AC4: an item naming a flag its actions never ran is rejected until the flag is run", async () => {
    const p = await project();
    const done = (id: string) => ({
      text: JSON.stringify({ checklist: [{ item: "hello --loud", actions: [id] }], findings: [] }),
    });
    const r = await p.run(
      ["explore", "DEMO-4", "--cli", "tool", "--goal", "Flags", "--check", "hello --loud"],
      {
        script: [
          { tools: [{ name: "cli_run", input: { args: ["hello"] } }] },
          done("A01"),
          { tools: [{ name: "cli_run", input: { args: ["hello", "--loud"] } }] },
          done("A02"),
        ],
      },
    );
    expect(r.err).toBe("");
    const session = CliExploreSessionSchema.parse(
      JSON.parse(await readFile(join(p.runDir, "explore", "S01", "session.json"), "utf8")),
    );
    expect(session.checklist).toEqual([{ item: "hello --loud", source: "person", actions: ["A02"] }]);
    const journal = await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8");
    // The refused claim is journaled for the audit.
    expect(journal).toContain('"event":"explore.answer_rejected"');
    expect(journal).toContain("names --loud, which none of its actions (A01) ran");
  }, 120_000);

  it("REQ-EXEC-25/AC7+AC8: an item cited with another subcommand, or skipped after its command failed, is sent back", async () => {
    const p = await project();
    const answer = (checklist: unknown[]) => ({ text: JSON.stringify({ checklist, findings: [] }) });
    const r = await p.run(
      [
        "explore",
        "DEMO-4",
        "--cli",
        "tool",
        "--goal",
        "S05",
        "--check",
        "tool hello",
        "--check",
        "tool fail",
      ],
      {
        script: [
          { tools: [{ name: "cli_run", input: { args: ["fail"] } }] },
          // hello never ran; fail ran and exited 2, which is its result.
          answer([
            { item: "hello", actions: ["A01"] },
            { item: "fail", not_done: "the command failed" },
          ]),
          { tools: [{ name: "cli_run", input: { args: ["hello"] } }] },
          answer([
            { item: "hello", actions: ["A02"] },
            { item: "fail", actions: ["A01"] },
          ]),
        ],
      },
    );
    expect(r.err).toBe("");
    const session = CliExploreSessionSchema.parse(
      JSON.parse(await readFile(join(p.runDir, "explore", "S01", "session.json"), "utf8")),
    );
    expect(session.checklist.map((c) => [c.item, c.actions])).toEqual([
      ["tool hello", ["A02"]],
      ["tool fail", ["A01"]],
    ]);
    const journal = await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8");
    expect(journal).toContain("names hello, which none of its actions (A01) ran");
    expect(journal).toContain("is not_done, but A01 ran it");
  }, 120_000);

  it("REQ-EXEC-24/AC9+AC10: --headed shows every command and its output live; --slow-mo paces it and is journaled", async () => {
    const p = await project();
    const r = await p.run(
      ["explore", "DEMO-4", "--cli", "tool", "--goal", "Watch", "--headed", "--slow-mo", "30"],
      {
        script: [
          { tools: [{ name: "cli_run", input: { args: ["ask"], input: ["yes"] } }] },
          { tools: [{ name: "cli_run", input: { args: ["fail"] } }] },
          {
            text: JSON.stringify({
              checklist: [{ item: "tool ask and tool fail", actions: ["A01", "A02"] }],
              findings: [],
            }),
          },
        ],
      },
    );
    expect(r.err).toBe("");
    expect(r.out).toContain("── A01 ");
    expect(r.out).toContain("$ tool ask\n> yes\n");
    expect(r.out).toContain("confirmed");
    expect(r.out).toContain("$ tool fail\n");
    expect(r.out).toContain("boom");
    expect(r.out).toContain("→ exit code 2 (");
    const journal = await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8");
    expect(journal).toMatch(/"explore\.start".*"headed":true,"slowMoMs":30/);
    const bad = await p.run(["explore", "DEMO-4", "--cli", "tool", "--goal", "x", "--slow-mo", "fast"]);
    expect(bad.exitCode).toBe(3);
    expect(bad.err).toContain("SLOW_MO_INVALID");
  }, 120_000);

  it("REQ-EXEC-15/AC9: commands asked for in one turn run one at a time, in order, each with its own id and output", async () => {
    const p = await project();
    const r = await p.run(["explore", "DEMO-4", "--cli", "tool", "--goal", "S06", "--headed"], {
      script: [
        // Session S06 of qwen3: three commands in one turn.
        {
          tools: [
            { name: "cli_run", input: { args: ["hello", "first"] } },
            { name: "cli_run", input: { args: ["fail"] } },
            { name: "cli_run", input: { args: ["hello", "third"] } },
          ],
        },
        {
          text: JSON.stringify({
            checklist: [{ item: "three commands", actions: ["A01", "A02", "A03"] }],
            findings: [],
          }),
        },
      ],
    });
    expect(r.err).toBe("");
    const dir = join(p.runDir, "explore", "S01");
    const session = CliExploreSessionSchema.parse(
      JSON.parse(await readFile(join(dir, "session.json"), "utf8")),
    );
    expect(session.endReason).toBe("finished");
    expect(session.actions.map((a) => [a.id, a.args.join(" "), a.exitCode])).toEqual([
      ["A01", "hello first", 0],
      ["A02", "fail", 2],
      ["A03", "hello third", 0],
    ]);
    expect(await readFile(join(dir, "evidence", "A03-output.txt"), "utf8")).toBe("hello third\n");
    const transcript = await readFile(join(dir, "evidence", "recordings", "terminal.txt"), "utf8");
    const at = (text: string) => transcript.indexOf(text);
    expect(at("$ tool hello first\nhello first\n→ exit code 0")).toBeGreaterThanOrEqual(0);
    expect(at("── A02")).toBeGreaterThan(at("→ exit code 0"));
    expect(at("$ tool fail\n")).toBeGreaterThan(at("── A02"));
    expect(at("── A03")).toBeGreaterThan(at("→ exit code 2"));
  }, 120_000);

  it("REQ-EXEC-15/AC5+AC9: the time box stops a running command and the commands queued after it never start", async () => {
    const p = await project();
    const started = Date.now();
    const r = await p.run(["explore", "DEMO-4", "--cli", "tool", "--goal", "Hang", "--time-box", "0.05"], {
      script: [
        {
          tools: [
            { name: "cli_run", input: { args: ["serve"] } },
            { name: "cli_run", input: { args: ["serve"] } },
            { name: "cli_run", input: { args: ["serve"] } },
          ],
        },
      ],
    });
    expect(r.exitCode).toBe(0);
    // Each serve would hang for the 20 s per-command timeout; the 3 s time box ends all of it.
    expect(Date.now() - started).toBeLessThan(15_000);
    const session = CliExploreSessionSchema.parse(
      JSON.parse(await readFile(join(p.runDir, "explore", "S01", "session.json"), "utf8")),
    );
    expect(session.endReason).toBe("time-box");
    expect(session.actions.map((a) => a.id)).toEqual(["A01"]);
  }, 120_000);

  it("REQ-EXEC-24/AC5: Ctrl+C stops the session, and what it started and its sandbox are gone afterwards", async () => {
    const p = await project();
    const signals = new EventEmitter();
    const journal = join(p.runDir, "journal", "events.jsonl");
    const press = setInterval(() => {
      void readFile(journal, "utf8")
        .catch(() => "")
        .then((text) => {
          if (text.includes('"event":"explore.action"')) {
            clearInterval(press);
            signals.emit("SIGINT");
          }
        });
    }, 100);
    const started = Date.now();
    const r = await p.run(["explore", "DEMO-4", "--cli", "tool", "--goal", "Stop"], {
      script: [
        { tools: [{ name: "cli_start", input: { args: ["serve"] } }] },
        { tools: [{ name: "cli_run", input: { args: ["serve"] } }] },
      ],
      signals,
    });
    clearInterval(press);
    expect(r.out).toContain("ended: error (stopped by Ctrl+C (SIGINT))");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    const session = CliExploreSessionSchema.parse(
      JSON.parse(await readFile(join(p.runDir, "explore", "S01", "session.json"), "utf8")),
    );
    expect(session.cleaned.processes.some((c) => c.startsWith("B1 "))).toBe(true);
    const sandbox = /"sandbox":"([^"]+)"/.exec(await readFile(journal, "utf8"))?.[1] ?? "";
    expect(sandbox).toContain("qj-sandbox-");
    await expect(stat(sandbox)).rejects.toThrow();
  }, 120_000);

  it("REQ-EXEC-25/AC1: without --check the explorer's own checklist is kept and marked as written by it", async () => {
    const p = await project();
    const r = await p.run(["explore", "DEMO-4", "--cli", "tool", "--goal", "Say hello"], {
      script: [
        { tools: [{ name: "cli_run", input: { args: ["hello"] } }] },
        { text: JSON.stringify({ checklist: [{ item: "say hello", actions: ["A01"] }], findings: [] }) },
      ],
    });
    expect(r.err).toBe("");
    const dir = join(p.runDir, "explore", "S01");
    const session = CliExploreSessionSchema.parse(
      JSON.parse(await readFile(join(dir, "session.json"), "utf8")),
    );
    expect(session.checklist).toEqual([{ item: "say hello", source: "explorer", actions: ["A01"] }]);
    expect(await readFile(join(dir, "report.md"), "utf8")).toContain(
      "Items written by the explorer from the goal: compare it with the goal.",
    );
    expect(
      (await p.run(["explore", "DEMO-4", "--cli", "tool", "--goal", "x", "--check", " "])).exitCode,
    ).toBe(3);
  }, 120_000);
});
