import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProjectConfig } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { envProviderContract } from "../../../../tests/contract/env-provider.contract.js";
import {
  createComposeEnvProvider,
  labelsFor,
  projectName,
  startBuildEnvironment,
  type CommandExec,
} from "./build.js";

const PASSWORD = "fictional-demo-password";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const workspace = async () => {
  const root = await mkdtemp(join(tmpdir(), "qj-build-"));
  dirs.push(root);
  const worktree = join(root, "repos", "shop");
  await mkdir(worktree, { recursive: true });
  await cp(
    fileURLToPath(new URL("../../../../examples/demo-shop/api", import.meta.url)),
    join(worktree, "api"),
    { recursive: true },
  );
  await writeFile(
    join(worktree, "docker-compose.yml"),
    "services:\n  db:\n    image: postgres:16\nvolumes:\n  data: {}\n",
  );
  const qaDir = join(root, ".qa");
  await mkdir(join(qaDir, "stubs", "payments"), { recursive: true });
  await mkdir(join(qaDir, "hooks"), { recursive: true });
  return { root, worktree, qaDir, envDir: join(root, "run", "env"), logsDir: join(root, "run", "logs") };
};

const base = {
  project: "demo",
  jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
  code_hosts: { local: { type: "local", root: "~/git" } },
  repos: { shop: { host: "local", path: "demo-org/demo-shop" } },
};
const apiService = {
  kind: "process",
  command: ["node", "api/server.mjs", "--port", "{{port}}"],
  env: { DEMO_USER_PASSWORD: { secret: "secret://env/DEMO_USER_PASSWORD" }, DEMO_SHA: "abc1234" },
  health: { http: "/health", timeout_s: 20 },
};

const composeProvider = async (api: typeof apiService) => {
  const ws = await workspace();
  const config = parseProjectConfig({
    ...base,
    services: { api },
    build: { repo: "shop", base_service: "api" },
  });
  return {
    provider: createComposeEnvProvider({
      ticket: "DEMO-1",
      runId: "20261005-0900-aaaa",
      config,
      qaDir: ws.qaDir,
      worktree: ws.worktree,
      envDir: ws.envDir,
      logsDir: ws.logsDir,
      resolveSecret: () => Promise.resolve(PASSWORD),
    }),
    cleanup: () => Promise.resolve(),
  };
};
envProviderContract(
  "compose (managed process)",
  () => composeProvider(apiService),
  () =>
    composeProvider({
      ...apiService,
      command: ["node", "-e", "process.exit(1)"],
      health: { http: "/health", timeout_s: 2 },
    }),
  true,
);

describe("--build environment (REQ-ENV-03, REQ-ENV-04, REQ-CFG-05, REQ-WS-02)", () => {
  it("REQ-ENV-03/AC2 + REQ-CTX-04/AC4: runs a managed process from the worktree with a dynamic port, logs and health check", async () => {
    const ws = await workspace();
    const config = parseProjectConfig({
      ...base,
      services: { api: apiService },
      build: { repo: "shop", base_service: "api" },
    });
    const env = await startBuildEnvironment({
      ticket: "DEMO-1",
      runId: "20261003-1046-aaaa",
      config,
      qaDir: ws.qaDir,
      worktree: ws.worktree,
      envDir: ws.envDir,
      logsDir: ws.logsDir,
      resolveSecret: () => Promise.resolve(PASSWORD),
    });
    try {
      expect(env.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(await (await fetch(`${env.baseUrl}/version`)).json()).toEqual({ sha: "abc1234" });
      const login = await fetch(`${env.baseUrl}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ username: "standard", password: PASSWORD }),
      });
      expect(login.status).toBe(200);
    } finally {
      const { logs } = await env.stop();
      expect(logs.map((l) => l.split("/").at(-1))).toEqual(["api.log"]);
    }
    expect(await readFile(join(ws.logsDir, "api.log"), "utf8")).toContain("demo-shop API on");
  });

  it("REQ-ENV-04/AC1: a log-line health check waits for the service's log", async () => {
    const ws = await workspace();
    const config = parseProjectConfig({
      ...base,
      services: { api: { ...apiService, health: { log: "demo-shop API on", timeout_s: 20 } } },
      build: { repo: "shop", base_service: "api" },
    });
    const env = await startBuildEnvironment({
      ticket: "DEMO-1",
      runId: "20261003-1046-aaaa",
      config,
      qaDir: ws.qaDir,
      worktree: ws.worktree,
      envDir: ws.envDir,
      logsDir: ws.logsDir,
      resolveSecret: () => Promise.resolve(PASSWORD),
      sleep: () => new Promise((r) => setTimeout(r, 20)),
    });
    try {
      expect((await fetch(`${env.baseUrl}/health`)).status).toBe(200);
    } finally {
      await env.stop();
    }
  });

  it("REQ-ENV-03/AC3: two builds run in parallel without port clashes", async () => {
    const a = await workspace();
    const b = await workspace();
    const config = parseProjectConfig({
      ...base,
      services: { api: apiService },
      build: { repo: "shop", base_service: "api" },
    });
    const start = (w: typeof a, run: string) =>
      startBuildEnvironment({
        ticket: "DEMO-1",
        runId: run,
        config,
        qaDir: w.qaDir,
        worktree: w.worktree,
        envDir: w.envDir,
        logsDir: w.logsDir,
        resolveSecret: () => Promise.resolve(PASSWORD),
      });
    const [x, y] = await Promise.all([start(a, "20261003-1046-aaaa"), start(b, "20261003-1046-bbbb")]);
    try {
      expect(x.baseUrl).not.toBe(y.baseUrl);
    } finally {
      await x.stop();
      await y.stop();
    }
  });

  it("REQ-ENV-04/AC3: a service that never becomes ready fails the start with its logs", async () => {
    const ws = await workspace();
    const config = parseProjectConfig({
      ...base,
      services: {
        api: {
          kind: "process",
          command: ["node", "-e", "console.log('booting'); setTimeout(() => {}, 60000)"],
          health: { http: "/health", timeout_s: 1 },
        },
      },
      build: { repo: "shop", base_service: "api" },
    });
    const error = await startBuildEnvironment({
      ticket: "DEMO-1",
      runId: "20261003-1046-aaaa",
      config,
      qaDir: ws.qaDir,
      worktree: ws.worktree,
      envDir: ws.envDir,
      logsDir: ws.logsDir,
      resolveSecret: () => Promise.resolve(""),
      sleep: () => new Promise((r) => setTimeout(r, 50)),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "BUILD_START_FAILED",
      context: { service: "api", logs: [join(ws.logsDir, "api.log")] },
    });
  });

  it("REQ-ENV-04/AC2: the demo seed hook runs after readiness and seeds data with the run marker", async () => {
    const ws = await workspace();
    await cp(
      fileURLToPath(new URL("../../../../examples/demo-shop/.qa/hooks/seed.mjs", import.meta.url)),
      join(ws.qaDir, "hooks", "seed.mjs"),
    );
    const config = parseProjectConfig({
      ...base,
      services: { api: apiService },
      build: { repo: "shop", base_service: "api", seed: "hooks/seed.mjs" },
    });
    const env = await startBuildEnvironment({
      ticket: "DEMO-1",
      runId: "20261003-1046-aaaa",
      config,
      qaDir: ws.qaDir,
      worktree: ws.worktree,
      envDir: ws.envDir,
      logsDir: ws.logsDir,
      resolveSecret: () => Promise.resolve(PASSWORD),
    });
    try {
      const { token } = (await (
        await fetch(`${env.baseUrl}/auth/login`, {
          method: "POST",
          body: JSON.stringify({ username: "admin", password: PASSWORD }),
        })
      ).json()) as { token: string };
      const seeds = await fetch(`${env.baseUrl}/admin/seed`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(await seeds.json()).toEqual({ markers: ["qj-DEMO-1-20261003-1046-aaaa"] });
    } finally {
      await env.stop();
    }
    expect(await readFile(join(ws.logsDir, "seed.log"), "utf8")).toContain(
      "seeded qj-DEMO-1-20261003-1046-aaaa",
    );
  });

  it("REQ-ENV-04/AC3: a failing seed hook fails the start and stops what was started", async () => {
    const ws = await workspace();
    await writeFile(join(ws.qaDir, "hooks", "seed.mjs"), "process.stderr.write('no seed'); process.exit(2);");
    const config = parseProjectConfig({
      ...base,
      services: { api: apiService },
      build: { repo: "shop", base_service: "api", seed: "hooks/seed.mjs" },
    });
    const error = await startBuildEnvironment({
      ticket: "DEMO-1",
      runId: "20261003-1046-aaaa",
      config,
      qaDir: ws.qaDir,
      worktree: ws.worktree,
      envDir: ws.envDir,
      logsDir: ws.logsDir,
      resolveSecret: () => Promise.resolve(PASSWORD),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "BUILD_START_FAILED", message: "Seed hook hooks/seed.mjs failed." });
    expect(await readFile(join(ws.logsDir, "seed.log"), "utf8")).toContain("no seed");
  });

  it("REQ-ENV-03/AC1 + REQ-WS-02 + REQ-CFG-05 + REQ-ENV-05: compose overlay with labels, dynamic ports, 0600 env files deleted after start, stubs listed", async () => {
    const ws = await workspace();
    const config = parseProjectConfig({
      ...base,
      services: {
        api: apiService,
        db: {
          kind: "compose",
          port: 5432,
          env: { POSTGRES_PASSWORD: { secret: "secret://env/DB_PASSWORD" } },
          health: { port: true, timeout_s: 1 },
        },
        payments: {
          kind: "stub",
          engine: "wiremock",
          mappings: "stubs/payments",
          health: { port: true, timeout_s: 1 },
        },
      },
      build: { repo: "shop", base_service: "api", compose_file: "docker-compose.yml" },
    });
    const calls: string[][] = [];
    const envFileModes: number[] = [];
    const composePath = await realpath(join(ws.worktree, "docker-compose.yml"));
    let composeModel: unknown = {
      services: { db: { ports: [{ host_ip: "127.0.0.1", published: "1", target: 5432 }] } },
    };
    let overlay: unknown;
    const listeners = await Promise.all(
      [0, 1].map(
        () =>
          new Promise<Server>((r) => {
            const s = createServer();
            s.listen(0, "127.0.0.1", () => {
              r(s);
            });
          }),
      ),
    );
    const ports = listeners.map((l) => (l.address() as { port: number }).port);
    const exec: CommandExec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes("up")) {
        overlay = parse(await readFile(join(ws.envDir, "compose.overlay.yml"), "utf8"));
        for (const f of (await readdir(ws.envDir)).filter((n) => n.endsWith(".env")))
          envFileModes.push((await stat(join(ws.envDir, f))).mode & 0o777);
      }
      if (args.includes("port"))
        return { stdout: `127.0.0.1:${String(args.includes("db") ? ports[0] : ports[1])}\n`, stderr: "" };
      if (args.includes("logs")) return { stdout: "service log line db-secret-123456\n", stderr: "" };
      if (args.includes("config")) return { stdout: JSON.stringify(composeModel), stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const env = await startBuildEnvironment({
      ticket: "DEMO-1",
      runId: "20261003-1046-aaaa",
      config,
      qaDir: ws.qaDir,
      worktree: ws.worktree,
      envDir: ws.envDir,
      logsDir: ws.logsDir,
      resolveSecret: (r) => Promise.resolve(r.endsWith("DB_PASSWORD") ? "db-secret-123456" : PASSWORD),
      exec,
      mask: (t) => t.replaceAll("db-secret-123456", "***"),
    });
    try {
      expect(projectName("DEMO-1", "20261003-1046-aaaa")).toBe("qj-demo-1-aaaa");
      expect(calls.find((c) => c.includes("up"))).toEqual([
        "docker",
        "compose",
        "--project-name",
        "qj-demo-1-aaaa",
        "--file",
        composePath,
        "--file",
        join(ws.envDir, "compose.overlay.yml"),
        "up",
        "--detach",
        "--build",
      ]);
      const o = overlay as {
        services: Record<
          string,
          { ports: string[]; labels: Record<string, string>; image?: string; env_file: string[] }
        >;
        networks: { default: { labels: unknown } };
        volumes: { data: { labels: unknown } };
      };
      expect(o.services["db"]).toMatchObject({
        ports: ["127.0.0.1::5432"],
        labels: labelsFor("DEMO-1", "20261003-1046-aaaa"),
      });
      expect(o.services["payments"]?.image).toMatch(/^wiremock\//);
      expect(o.networks.default.labels).toEqual(labelsFor("DEMO-1", "20261003-1046-aaaa"));
      expect(o.volumes.data.labels).toEqual(labelsFor("DEMO-1", "20261003-1046-aaaa"));
      expect(envFileModes).toEqual([0o600, 0o600]);
      expect((await readdir(ws.envDir)).filter((n) => n.endsWith(".env"))).toEqual([]);
      expect(JSON.stringify(overlay)).not.toContain("db-secret-123456");
      // After up the overlay no longer names the deleted env files, so logs/port/down still parse it.
      expect(await readFile(join(ws.envDir, "compose.overlay.yml"), "utf8")).not.toContain("env_file");
      expect(JSON.stringify(overlay)).toContain("env_file");
      expect(env.stubs).toEqual(["payments (wiremock)"]);
      expect(env.services["db"]?.url).toBe(`http://127.0.0.1:${String(ports[0])}`);
    } finally {
      await env.stop();
      for (const l of listeners) l.close();
    }
    expect(calls.at(-1)).toEqual([
      "docker",
      "compose",
      "--project-name",
      "qj-demo-1-aaaa",
      "--file",
      composePath,
      "--file",
      join(ws.envDir, "compose.overlay.yml"),
      "down",
      "--volumes",
      "--remove-orphans",
    ]);
    // Logs are masked before they are written (invariant 8).
    expect(await readFile(join(ws.logsDir, "db.log"), "utf8")).toBe("service log line ***\n");

    // The analysed branch's compose model is checked before up (privileged, host network, ...).
    composeModel = { services: { db: { privileged: true, network_mode: "host" } } };
    calls.length = 0;
    const rejected = await startBuildEnvironment({
      ticket: "DEMO-1",
      runId: "20261003-1046-bbbb",
      config,
      qaDir: ws.qaDir,
      worktree: ws.worktree,
      envDir: ws.envDir,
      logsDir: ws.logsDir,
      resolveSecret: () => Promise.resolve("db-secret-123456"),
      exec,
    }).catch((e: unknown) => e);
    expect(rejected).toMatchObject({ code: "BUILD_START_FAILED" });
    expect((rejected as Error).message).toContain("db: privileged containers are not allowed");
    expect(calls.some((c) => c.includes("up"))).toBe(false);
    expect((await readdir(ws.envDir)).filter((n) => n.endsWith(".env"))).toEqual([]);
  });

  it("REQ-ENV-03: a compose_file symlinked outside the worktree is refused without reading it", async () => {
    const ws = await workspace();
    await writeFile(join(ws.root, "credentials"), "aws_secret_access_key = fictional");
    await rm(join(ws.worktree, "docker-compose.yml"));
    await symlink(join(ws.root, "credentials"), join(ws.worktree, "docker-compose.yml"));
    const config = parseProjectConfig({
      ...base,
      services: { db: { kind: "compose", port: 5432 } },
      build: { repo: "shop", base_service: "db", compose_file: "docker-compose.yml" },
    });
    const error = await startBuildEnvironment({
      ticket: "DEMO-1",
      runId: "20261003-1046-aaaa",
      config,
      qaDir: ws.qaDir,
      worktree: ws.worktree,
      envDir: ws.envDir,
      logsDir: ws.logsDir,
      resolveSecret: () => Promise.resolve(""),
      exec: () => Promise.reject(new Error("docker must not run")),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "BUILD_START_FAILED" });
    expect((error as Error).message).toBe("docker-compose.yml points outside the worktree.");
  });

  it("refuses a run without build configuration", async () => {
    const ws = await workspace();
    await expect(
      startBuildEnvironment({
        ticket: "DEMO-1",
        runId: "20261003-1046-aaaa",
        config: parseProjectConfig(base),
        qaDir: ws.qaDir,
        worktree: ws.worktree,
        envDir: ws.envDir,
        logsDir: ws.logsDir,
        resolveSecret: () => Promise.resolve(""),
      }),
    ).rejects.toMatchObject({ code: "BUILD_NOT_CONFIGURED" });
  });
});
