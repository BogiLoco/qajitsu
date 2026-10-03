import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PASSWORD, apiService, createBuildProject, record } from "../../../../tests/support/cli-build.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const setup = async (services?: string) => {
  const p = await createBuildProject(services);
  cleanups.push(p.cleanup);
  return p;
};

describe("qajitsu run --build (stage 6)", () => {
  it("REQ-CTX-04/AC4 + REQ-ENV-03/AC2 + REQ-CFG-01/AC2 + REQ-WS-03/AC1: builds from the worktree, passes, records the masked effective config and cleans up", async () => {
    const { run, prepare } = await setup();
    const dir = await prepare();
    const result = await run(["run", "DEMO-1", "--build"]);
    expect(result.err).toBe("");
    expect(result.exitCode).toBe(0);
    const { data } = await record(dir);
    expect(data.environment).toMatchObject({ name: "build (local)", versionCheck: "built-from-worktree" });
    expect(String(data.environment["baseUrl"])).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(data["build"]).toMatchObject({
      project: expect.stringMatching(/^qj-demo-1-[a-z0-9]{4}$/) as unknown,
    });
    const config = JSON.stringify(data["config"]);
    expect(config).toContain('"base_service":"api"');
    expect(config).not.toContain(PASSWORD);
    // on_success: worktree and env files removed, logs and artifacts kept.
    expect(await readdir(join(dir, "repos"))).not.toContain("shop");
    expect(await readdir(join(dir, "env"))).toEqual([]);
    expect(await readdir(join(dir, "logs"))).toEqual(expect.arrayContaining(["api.log", "seed.log"]));
    expect(await readFile(join(dir, "logs", "seed.log"), "utf8")).toContain("seeded qj-DEMO-1-");
    expect(await readdir(join(dir, "results"))).toEqual(["TC-01.json", "TC-02.json"]);
  }, 120_000);

  it("REQ-CFG-02/AC3 + REQ-WS-03/AC1: --set switches a bug on for one run; a failed run keeps its worktree", async () => {
    const { run, prepare } = await setup();
    const dir = await prepare();
    const result = await run(["run", "DEMO-1", "--build", "--set", "api.BUG_CART_TOTAL_ROUNDING=1"]);
    expect(result.exitCode).toBe(1);
    expect(result.out).toContain("Environment kept");
    expect(await readdir(join(dir, "repos"))).toContain("shop");
    expect(await readdir(join(dir, "env"))).toEqual([]);
    const { data } = await record(dir);
    expect(data["config"]).toMatchObject({ overrides: { api: { BUG_CART_TOTAL_ROUNDING: "1" } } });
  }, 120_000);

  it("REQ-ENV-04/AC3: a start failure makes every case BLOCKED with the service log as evidence", async () => {
    const { run, prepare } = await setup(
      apiService(`["node", "-e", "console.log('boom ' + process.env.DEMO_USER_PASSWORD); process.exit(1)"]`),
    );
    const dir = await prepare();
    const result = await run(["run", "DEMO-1", "--build"]);
    expect(result.exitCode).toBe(2);
    expect(result.err).toContain("every case is BLOCKED");
    const manifest = JSON.parse(await readFile(join(dir, "evidence", "manifest.json"), "utf8")) as {
      path: string;
      kind: string;
    }[];
    expect(manifest.map((e) => [e.path, e.kind])).toEqual([
      ["TC-01/attempt-1/api.log", "log"],
      ["TC-02/attempt-1/api.log", "log"],
    ]);
    const log = await readFile(join(dir, "evidence", "TC-01", "attempt-1", "api.log"), "utf8");
    expect(log).toContain("boom");
    expect(log).not.toContain(PASSWORD);
    const tc1 = JSON.parse(await readFile(join(dir, "results", "TC-01.json"), "utf8")) as {
      attempts: { outcome: string; error: string }[];
    };
    expect(tc1.attempts[0]).toMatchObject({ outcome: "error" });
    expect(tc1.attempts[0]?.error).toContain("environment did not start");
    expect(await readFile(join(dir, "report", "matrix.md"), "utf8")).toContain("BLOCKED");
  }, 120_000);

  it("REQ-CFG-05/AC2: an interrupt stops the environment, deletes .env files and exits with 130", async () => {
    const { EventEmitter } = await import("node:events");
    const signals = new EventEmitter();
    const exited: number[] = [];
    let baseUrl = "";
    let envDir = "";
    const { inProcessExecutor } = await import("../../../../tests/support/cli-pipeline.js");
    const p = await createBuildProject(undefined, {
      ports: {
        signals,
        exit: (code) => exited.push(code),
        executor: async (input) => {
          if (exited.length === 0) {
            baseUrl = input.baseUrl;
            await writeFile(join(envDir, "api.env"), `DEMO_USER_PASSWORD="${PASSWORD}"\n`, { mode: 0o600 });
            signals.emit("SIGINT");
            signals.emit("SIGINT");
            await new Promise((r) => setTimeout(r, 300));
          }
          return inProcessExecutor(input);
        },
      },
    });
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    envDir = join(dir, "env");
    await p.run(["run", "DEMO-1", "--build"]);
    expect(exited).toEqual([130]);
    expect(await readdir(envDir)).toEqual([]);
    await expect(fetch(`${baseUrl}/health`)).rejects.toThrow();
    expect(signals.listenerCount("SIGINT")).toBe(0);
  }, 120_000);

  it("REQ-CFG-04/AC2: an invalid configuration ends with exit code 3 before anything starts", async () => {
    const { run, prepare } = await setup();
    const dir = await prepare();
    const notOverridable = await run(["run", "DEMO-1", "--build", "--set", "api.DEMO_USER_PASSWORD=x"]);
    expect(notOverridable.exitCode).toBe(3);
    expect(notOverridable.err).toContain("api.DEMO_USER_PASSWORD: variable is not overridable");
    expect(await readdir(join(dir, "logs"))).not.toContain("api.log");
    expect((await run(["run", "DEMO-1", "--keep"])).err).toContain(
      "--keep and --set apply to --build runs only",
    );
    expect((await run(["run", "DEMO-1", "--build", "--env", "http://127.0.0.1:1"])).exitCode).toBe(3);
    expect((await run(["run", "DEMO-1", "--build", "--set", "nonsense"])).err).toContain("OVERRIDE_INVALID");
    expect((await run(["run", "DEMO-1", "--build", "--set", "web.X=1"])).err).toContain(
      "--set web: unknown service",
    );
  }, 120_000);
});
