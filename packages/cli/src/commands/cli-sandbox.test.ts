import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  changedFiles,
  cleanUpLeftovers,
  createSandbox,
  findLeftovers,
  fromBase,
  insideSandbox,
  removeSandbox,
  sandboxEnv,
  snapshotFiles,
  startAllowlistProxy,
  startCommand,
  type CliSandbox,
} from "./cli-sandbox.js";

/** Real `ps`, no Docker: the tests do not depend on the machine's containers or a hung Docker. */
const noDocker = (program: string, args: readonly string[]): Promise<string | undefined> =>
  program === "docker"
    ? Promise.resolve(undefined)
    : new Promise((done) => {
        execFile(program, [...args], { timeout: 15_000, killSignal: "SIGKILL" }, (e, out) => {
          done(e ? undefined : out);
        });
      });
const TOOL = fileURLToPath(new URL("../../../../fixtures/cli-tool/tool.mjs", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const sandbox = async (): Promise<CliSandbox> => {
  const s = await createSandbox(undefined);
  cleanups.push(() => removeSandbox(s));
  return s;
};
const tool = (s: CliSandbox, args: string[], extra: Partial<Parameters<typeof startCommand>[0]> = {}) =>
  startCommand({
    program: process.execPath,
    baseArgs: [TOOL],
    args,
    cwd: s.work,
    env: sandboxEnv(s, "http://127.0.0.1:9", {}),
    timeoutMs: 10_000,
    ...extra,
  });

describe("sandbox of a command-line session (REQ-EXEC-24)", () => {
  it("REQ-EXEC-24/AC1: the fixture is copied without node_modules and .git; work, home and tmp are separate", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "qj-fixture-"));
    cleanups.push(() => rm(fixture, { recursive: true, force: true }));
    await mkdir(join(fixture, "node_modules", "x"), { recursive: true });
    await mkdir(join(fixture, ".git"), { recursive: true });
    await writeFile(join(fixture, "app.txt"), "app");
    const s = await createSandbox(fixture);
    cleanups.push(() => removeSandbox(s));
    expect([...(await snapshotFiles(s.root)).keys()]).toEqual([join("work", "app.txt")]);
    expect(s.markers.length).toBeGreaterThanOrEqual(1);
    expect(fromBase("/qa", "../bin/tool")).toBe("/bin/tool");
    expect(fromBase("/qa", "node")).toBe("node");
  });

  it("REQ-EXEC-24/AC2: the tool gets PATH, its own HOME and TMPDIR, the proxy and the configured variables, nothing else", async () => {
    const s = await sandbox();
    const env = sandboxEnv(
      s,
      "http://127.0.0.1:1234",
      { TOOL_TOKEN: "t0k3n" },
      {
        PATH: "/bin",
        LANG: "pl_PL.UTF-8",
        GITHUB_TOKEN: "real-secret",
        AWS_SECRET_ACCESS_KEY: "aws",
        SSH_AUTH_SOCK: "/tmp/agent",
      },
    );
    expect(env["PATH"]).toBe("/bin");
    expect(env["HOME"]).toBe(s.home);
    expect(env["HTTPS_PROXY"]).toBe("http://127.0.0.1:1234");
    expect(env["TOOL_TOKEN"]).toBe("t0k3n");
    expect(Object.keys(env)).not.toContain("GITHUB_TOKEN");
    expect(Object.keys(env)).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(Object.keys(env)).not.toContain("SSH_AUTH_SOCK");
  });

  it("REQ-EXEC-24/AC2+AC3: runs with an argument array (no shell), answers prompts, reports exit codes and output", async () => {
    const s = await sandbox();
    const hello = tool(s, ["hello", "$(whoami); rm -rf /"]);
    expect(await hello.wait(10_000)).toEqual({ exitCode: 0, timedOut: false });
    expect(hello.allOutput()).toBe("hello $(whoami); rm -rf /\n");
    const fail = tool(s, ["fail"]);
    expect((await fail.wait(10_000))?.exitCode).toBe(2);
    expect(fail.takeOutput()).toContain("boom");
    expect(fail.takeOutput()).toBe("");
    const yes = tool(s, ["ask"], { input: ["yes"] });
    expect((await yes.wait(10_000))?.exitCode).toBe(0);
    expect(yes.allOutput()).toContain("confirmed");
    const missing = startCommand({
      program: join(s.root, "no-such-program"),
      baseArgs: [],
      args: [],
      cwd: s.work,
      env: {},
      timeoutMs: 5000,
    });
    expect((await missing.wait(5000))?.exitCode).not.toBe(0);
  });

  it("REQ-EXEC-24/AC3: a background command gets lines and Ctrl+C; the timeout stops a command that hangs", async () => {
    const s = await sandbox();
    const serve = tool(s, ["serve"], { interactive: true });
    expect(await serve.wait(300)).toBeUndefined();
    expect(serve.ended()).toBeUndefined();
    serve.send("ignored");
    serve.signal("SIGINT");
    expect((await serve.wait(10_000))?.exitCode).toBe(0);
    expect(serve.allOutput()).toContain("stopped");
    const hang = tool(s, ["serve"], { timeoutMs: 300 });
    const end = await hang.wait(10_000);
    expect(end?.timedOut).toBe(true);
  });

  it("REQ-EXEC-24/AC3+AC5: a process left behind is found by the sandbox in its command line and stopped", async () => {
    const s = await sandbox();
    const orphan = tool(s, ["orphan"]);
    await orphan.wait(10_000);
    const pid = Number(/started (\d+)/.exec(orphan.allOutput())?.[1]);
    expect(pid).toBeGreaterThan(0);
    const serve = tool(s, ["serve"], { interactive: true });
    const running = [{ id: "B1", command: serve }];
    const found = await findLeftovers(s, running, noDocker);
    expect(found.processes.some((p) => p.startsWith("B1 "))).toBe(true);
    expect(found.pids).toContain(pid);
    const cleaned = await cleanUpLeftovers(s, running, noDocker);
    expect(cleaned.processes.length).toBeGreaterThanOrEqual(2);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(serve.ended()).toBeDefined();
    expect((await findLeftovers(s, running, noDocker)).processes).toEqual([]);
  });

  it("REQ-EXEC-24/AC3: ports the left processes listen on are listed", async () => {
    const s = await sandbox();
    const probe = (program: string) =>
      Promise.resolve(
        program === "ps"
          ? `4242 node server.js ${s.root}/work\n`
          : program === "lsof"
            ? "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 4242 me 20u IPv4 0x1 0t0 TCP 127.0.0.1:5173 (LISTEN)\n"
            : undefined,
      );
    expect((await findLeftovers(s, [], probe)).processes).toEqual([
      `pid 4242: node server.js ${s.root}/work`,
      "pid 4242 listens on port 5173",
    ]);
  });

  it("REQ-EXEC-24/AC3+AC5: containers that name the sandbox are listed and removed; Docker missing is not an error", async () => {
    const s = await sandbox();
    const calls: string[] = [];
    const probe = (program: string, args: readonly string[]) => {
      calls.push(`${program} ${args.join(" ")}`);
      if (program === "ps") return Promise.resolve("");
      if (args[0] === "ps")
        return Promise.resolve(
          `abc123\tqj-demo-1-x-api-1\tcom.docker.compose.project.working_dir=${s.root}/home/runs\t\nzzz999\tother\tx=y\t\n`,
        );
      return Promise.resolve("");
    };
    const cleaned = await cleanUpLeftovers(s, [], probe);
    expect(cleaned.containers).toEqual(["qj-demo-1-x-api-1 (abc123)"]);
    expect(calls).toContain("docker rm -f abc123");
    expect(await findLeftovers(s, [], () => Promise.resolve(undefined))).toMatchObject({
      processes: [],
      containers: [],
    });
  });

  it("REQ-EXEC-24/AC3: files are read only inside the sandbox, links out of it included; changes are listed", async () => {
    const s = await sandbox();
    await writeFile(join(s.work, "a.txt"), "a");
    const before = await snapshotFiles(s.root);
    await writeFile(join(s.work, "b.txt"), "b");
    await writeFile(join(s.work, "a.txt"), "aa");
    expect(changedFiles(before, await snapshotFiles(s.root))).toEqual([
      `~ ${join("work", "a.txt")}`,
      `+ ${join("work", "b.txt")}`,
    ]);
    expect(await insideSandbox(s, "a.txt")).toMatch(/a\.txt$/);
    expect(await insideSandbox(s, "../../../../etc/hosts")).toBeUndefined();
    expect(await insideSandbox(s, "/etc/hosts")).toBeUndefined();
    await symlink("/etc", join(s.work, "out"));
    expect(await insideSandbox(s, "out/hosts")).toBeUndefined();
    expect(await insideSandbox(s, "missing.txt")).toBeUndefined();
  });

  it("REQ-EXEC-24/AC2: the proxy forwards loopback and allowlisted hosts and refuses the rest", async () => {
    const target = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((d) => target.listen(0, "127.0.0.1", d));
    cleanups.push(
      () =>
        new Promise<void>((d) => {
          target.close(() => {
            d();
          });
        }),
    );
    const port = (target.address() as { port: number }).port;
    const refused: string[] = [];
    const proxy = await startAllowlistProxy(["https://api.example.test"], (h) => refused.push(h));
    cleanups.push(proxy.close);
    const s = await sandbox();
    const get = async (url: string) => {
      const c = startCommand({
        program: process.execPath,
        baseArgs: [TOOL],
        args: ["get", url],
        cwd: s.work,
        env: sandboxEnv(s, proxy.url, {}),
        timeoutMs: 10_000,
      });
      await c.wait(10_000);
      return c.allOutput().trim();
    };
    expect(await get(`http://127.0.0.1:${String(port)}/`)).toBe("200 ok");
    expect(await get("http://evil.example.test/steal")).toBe("403 refused by the QAJitsu allowlist");
    expect(refused).toEqual(["evil.example.test:80"]);
  });
});
