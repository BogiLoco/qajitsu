import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitExec, parseEventLines } from "@qajitsu/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimePorts } from "../adapters.js";
import { createProgram } from "../program.js";

const gitExec = createGitExec({ PATH: process.env["PATH"] ?? "", HOME: tmpdir() });

describe("qajitsu fetch (stage 1 demo: REQ-CTX-01..04, REQ-WS-01, REQ-GEN-05)", () => {
  let home: string;
  let project: string;
  let sha: string;
  let seq = 0;

  beforeEach(async () => {
    seq = 0;
    home = await mkdtemp(join(tmpdir(), "qj-home-"));
    project = join(home, "project");
    const repo = join(home, "git", "demo-org", "demo-shop");
    const g = (...args: string[]) =>
      gitExec(["-C", repo, "-c", "user.name=qa", "-c", "user.email=qa@example.com", ...args]);
    await gitExec(["init", "-q", "-b", "main", repo]);
    await writeFile(join(repo, "cart.ts"), "export const v = 1;\n");
    await g("add", ".");
    await g("commit", "-qm", "init");
    await g("checkout", "-qb", "feature/DEMO-1-cart-discounts");
    await writeFile(join(repo, "cart.ts"), "export const v = 2;\n");
    await g("commit", "-qam", "DEMO-1 discounts");
    sha = (await g("rev-parse", "HEAD")).stdout.trim();
    await g("checkout", "-q", "main");

    await mkdir(join(project, ".qa"), { recursive: true });
    await mkdir(join(project, "tickets"));
    await writeFile(
      join(project, "tickets", "DEMO-1.json"),
      JSON.stringify({
        key: "DEMO-1",
        summary: "Cart total",
        description: "d",
        acceptanceCriteria: ["Rounded once"],
        comments: [{ author: "po", created: "2026-09-30T10:12:00Z", body: "token SECRET_VALUE_123" }],
      }),
    );
    await writeFile(
      join(project, ".qa", "qa.project.yaml"),
      [
        "project: demo",
        "jira: { type: file, tickets_dir: ../tickets, project_key: DEMO }",
        "workspace: { root: ~/runs, git_cache: ~/cache }",
        "code_hosts: { local: { type: local, root: ~/git } }",
        "repos: { shop: { host: local, path: demo-org/demo-shop } }",
        "environments: { allowlist: ['http://localhost:3000'] }",
      ].join("\n"),
    );
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const run = async (args: string[], cwd = project, ask?: (q: string) => Promise<string>) => {
    let out = "";
    let err = "";
    let exitCode = 0;
    const ports: RuntimePorts = {
      env: {},
      home,
      now: () => new Date("2026-10-03T10:46:00Z"),
      // First run id ends in "aaaa"; later runs get different suffixes.
      random: () => {
        const value = seq < 4 ? 0 : (seq % 36) / 36;
        seq += 1;
        return value;
      },
      fetch: () => Promise.reject(new Error("no network in tests")),
      gitExec,
    };
    await createProgram("1.0.0", {
      write: (t) => (out += t),
      writeError: (t) => (err += t),
      cwd,
      nodeVersion: "v22.22.0",
      setExitCode: (c) => (exitCode = c),
      ports,
      ...(ask ? { ask } : {}),
    })
      .exitOverride()
      .parseAsync(["node", "qj", ...args]);
    return { out, err, exitCode };
  };

  it("REQ-WS-01 + REQ-CTX-04: writes ticket/, repos/ and SHAs into a new run folder", async () => {
    const result = await run(["fetch", "DEMO-1"]);
    expect(result.err).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain("Change discovery: ticket_key_in_branch");
    const runDir = join(home, "runs", "DEMO-1", "20261003-1046-aaaa");
    expect(JSON.parse(await readFile(join(runDir, "ticket", "ticket.json"), "utf8"))).toMatchObject({
      key: "DEMO-1",
    });
    expect(await readFile(join(runDir, "repos", "shop", "cart.ts"), "utf8")).toContain("v = 2");
    expect(await readFile(join(runDir, "repos", "shop.diff"), "utf8")).toContain("+export const v = 2;");
    const record = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as {
      repos: Record<string, { sha: string }>;
    };
    expect(record.repos["shop"]?.sha).toBe(sha);
    const { events, invalidLines } = parseEventLines(
      await readFile(join(runDir, "journal", "events.jsonl"), "utf8"),
    );
    expect(invalidLines).toEqual([]);
    expect(events.at(-1)?.event).toBe("stage.end");
    expect(await readdir(join(home, "cache", "local", "demo-org"))).toEqual(["demo-shop.git"]);
  });

  it("REQ-CTX-03/AC3: --ref overrides discovery", async () => {
    const result = await run(["fetch", "DEMO-1", "--ref", "main"]);
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain("Change discovery: manual");
    expect(result.out).toContain("shop: branch main");
  });

  it("REQ-CTX-01/AC3: rejects a malformed key with exit code 3 before anything happens", async () => {
    const result = await run(["fetch", "../../etc"]);
    expect(result.exitCode).toBe(3);
    expect(result.err).toContain("Invalid ticket key");
    await expect(readdir(join(home, "runs"))).rejects.toThrow();
  });

  it("REQ-CTX-01/AC5: an unfetchable ticket ends with exit code 3", async () => {
    const result = await run(["fetch", "DEMO-404"]);
    expect(result.exitCode).toBe(3);
    expect(result.err).toContain("[JIRA_NOT_FOUND]");
  });

  it("REQ-CTX-03/AC5: no change in CI stops with a clear message; interactive asks", async () => {
    await writeFile(
      join(project, "tickets", "DEMO-2.json"),
      JSON.stringify({ key: "DEMO-2", summary: "x", comments: [] }),
    );
    const ci = await run(["fetch", "DEMO-2"]);
    expect(ci.exitCode).toBe(3);
    expect(ci.err).toContain("[CHANGE_NOT_FOUND]");
    const questions: string[] = [];
    const interactive = await run(["fetch", "DEMO-2"], project, (q) => {
      questions.push(q);
      return Promise.resolve("shop=main");
    });
    expect(questions[0]).toContain("No PR/MR or branch for DEMO-2");
    expect(interactive.exitCode).toBe(0);
  });

  it("REQ-GEN-01: configuration errors list every issue and exit with 3", async () => {
    await writeFile(join(project, ".qa", "qa.project.yaml"), "project: Demo\njira: {}\n");
    const bad = await run(["fetch", "DEMO-1"]);
    expect(bad.exitCode).toBe(3);
    expect(bad.err).toContain("[CONFIG_INVALID]");
    expect(bad.err).toContain("  - project:");
    await writeFile(join(project, ".qa", "qa.project.yaml"), "project: [\n");
    expect((await run(["fetch", "DEMO-1"])).err).toContain("[CONFIG_YAML_INVALID]");
    expect((await run(["fetch", "DEMO-1"], home)).err).toContain("[CONFIG_NOT_FOUND]");
  });

  it("finds .qa/ from a subfolder", async () => {
    await mkdir(join(project, "src", "deep"), { recursive: true });
    expect((await run(["fetch", "DEMO-1"], join(project, "src", "deep"))).exitCode).toBe(0);
  });
});
