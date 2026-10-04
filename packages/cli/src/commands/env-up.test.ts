import { EventEmitter } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiService, createBuildProject, record } from "../../../../tests/support/cli-build.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** Waits until `qj env up` has recorded the started environment in run.json. */
const startedBuild = async (dir: string): Promise<{ ports: Record<string, number> }> => {
  for (let i = 0; i < 600; i++) {
    const build = (await record(dir)).data["build"] as { ports: Record<string, number> } | undefined;
    if (build) return build;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("environment did not start");
};

describe("qajitsu env up (REQ-GEN-05/AC2)", () => {
  it("REQ-GEN-05/AC2 + REQ-ENV-03: starts the environment from the run's worktree without agents and stops it on Ctrl+C", async () => {
    const signals = new EventEmitter();
    const p = await createBuildProject(undefined, { ports: { signals } });
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    const running = p.run(["env", "up", "DEMO-1"]);
    const build = await startedBuild(dir);
    const url = `http://127.0.0.1:${String(build.ports["api"])}`;
    expect((await fetch(`${url}/health`)).ok).toBe(true);
    expect(signals.listenerCount("SIGINT")).toBe(1);
    signals.emit("SIGINT");
    const result = await running;
    expect(result.err).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain(`api: ${url}`);
    expect(result.out).toContain("Ctrl+C");
    await expect(fetch(`${url}/health`)).rejects.toThrow();
    // Generated .env files are gone, the worktree stays for a later `qj run`, no results were written.
    expect(await readdir(join(dir, "env"))).toEqual([]);
    expect(await readdir(join(dir, "repos"))).toContain("shop");
    expect(await readdir(join(dir, "results"))).toEqual([]);
    expect(await readdir(join(dir, "logs"))).toEqual(expect.arrayContaining(["api.log", "seed.log"]));
    const journal = await readFile(join(dir, "journal", "events.jsonl"), "utf8");
    expect(journal).toContain('"env.up"');
    expect(journal).toContain('"env.down"');
    expect(signals.listenerCount("SIGINT")).toBe(0);
  }, 120_000);

  it("REQ-GEN-05/AC2 + REQ-ENV-04/AC3: a start failure ends with exit code 2 and names the service logs", async () => {
    const p = await createBuildProject(apiService(`["node", "-e", "process.exit(1)"]`));
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    const result = await p.run(["env", "up", "DEMO-1"]);
    expect(result.exitCode).toBe(2);
    expect(result.err).toContain("did not start");
    expect(result.err).toContain(join(dir, "logs", "api.log"));
    expect(await readdir(join(dir, "env"))).toEqual([]);
  }, 120_000);

  it("REQ-GEN-05/AC2: --detach refuses managed processes, which cannot outlive the command", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    const result = await p.run(["env", "up", "DEMO-1", "--detach"]);
    expect(result.exitCode).toBe(3);
    expect(result.err).toContain("DETACH_WITH_PROCESSES");
    expect((await record(dir)).data["build"]).toBeUndefined();
  }, 120_000);

  it("REQ-GEN-05/AC2 + REQ-CFG-04/AC2: an invalid --set ends with exit code 3 before anything starts", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    const result = await p.run(["env", "up", "DEMO-1", "--set", "api.DEMO_USER_PASSWORD=x"]);
    expect(result.exitCode).toBe(3);
    expect(result.err).toContain("variable is not overridable");
    expect(await readdir(join(dir, "logs"))).not.toContain("api.log");
  }, 120_000);
});
