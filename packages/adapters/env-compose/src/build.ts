import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { join, resolve } from "node:path";
import {
  AdapterError,
  ConfigError,
  resolveServiceEnv,
  toDotenv,
  type Endpoint,
  type ProjectConfig,
  type ServiceConfig,
} from "@qajitsu/core";
import { parse, stringify } from "yaml";

/** Runs a command with an argument array (never a shell string). */
export type CommandExec = (
  cmd: string,
  args: readonly string[],
  options?: {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly env?: Readonly<Record<string, string>>;
  },
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

/** Default `CommandExec` on `child_process.execFile`. */
export const execCommand: CommandExec = (cmd, args, options = {}) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      cmd,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 600_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, ...options.env },
      },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(new Error(`${cmd} ${args[0] ?? ""} failed`), { stderr }));
        else resolvePromise({ stdout, stderr });
      },
    );
  });

const stderrOf = (error: unknown): string => {
  const v = (error as { stderr?: unknown }).stderr;
  return typeof v === "string" ? v : "";
};

/** Labels on every runtime resource (REQ-WS-02/AC1). */
export const labelsFor = (ticket: string, runId: string): Record<string, string> => ({
  "qajitsu.ticket": ticket,
  "qajitsu.run": runId,
  "qajitsu.managed": "true",
});

/** Compose project name `qj-<ticket>-<suffix>` (REQ-WS-02/AC2). */
export const projectName = (ticket: string, runId: string): string =>
  `qj-${ticket.toLowerCase()}-${runId.slice(-4)}`;

/** A free TCP port on localhost. */
export const freePort = (): Promise<number> =>
  new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => {
        resolvePromise(port);
      });
    });
  });

/** Settings of one `--build` environment. */
export interface BuildOptions {
  readonly ticket: string;
  readonly runId: string;
  readonly config: ProjectConfig;
  readonly qaDir: string;
  /** Worktree of the build repository (REQ-CTX-04/AC4). */
  readonly worktree: string;
  /** The run's `env/` folder (generated files, never read by agents). */
  readonly envDir: string;
  /** The run's `logs/` folder. */
  readonly logsDir: string;
  readonly resolveSecret: (reference: string) => Promise<string>;
  readonly exec?: CommandExec;
  readonly fetch?: typeof globalThis.fetch;
  /** Run-level overrides of overridable variables, per service (REQ-CFG-02/AC3). */
  readonly overrides?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** A started build environment. */
export interface BuildEnvironment {
  readonly baseUrl: string;
  readonly services: Readonly<Record<string, { readonly kind: ServiceConfig["kind"]; readonly url: string }>>;
  /** Stubbed services, listed in the report (REQ-ENV-05/AC2). */
  readonly stubs: readonly string[];
  /** Stops everything this run started and writes service logs to `logs/` (REQ-WS-03). */
  stop(): Promise<{ readonly logs: readonly string[] }>;
}

/** Start failure with the service logs collected so far (REQ-ENV-04/AC3). */
export class BuildStartError extends AdapterError {}

const STUB_IMAGES: Record<string, { image: string; port: number; mount: string }> = {
  wiremock: { image: "wiremock/wiremock:3.9.1", port: 8080, mount: "/home/wiremock/mappings" },
  mockoon: { image: "mockoon/cli:9.1.0", port: 3000, mount: "/data" },
};

const waitFor = async (
  check: () => Promise<boolean>,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return true;
    await sleep(250);
  }
  return false;
};

const tcpOpen = (port: number): Promise<boolean> =>
  new Promise((resolvePromise) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", () => {
      resolvePromise(false);
    });
  });

/**
 * Starts the application from the analysed worktree (REQ-ENV-03, REQ-ENV-04, REQ-ENV-05, REQ-CFG-05):
 * compose services through the project's compose file plus a generated overlay (dynamic localhost ports,
 * labels, env files), stubs as containers, other services as managed processes; then health checks and
 * the optional seed hook. Generated `.env` files are deleted as soon as the containers have started.
 *
 * @param options - Build settings and ports.
 * @throws {BuildStartError} `BUILD_START_FAILED` with the collected logs when anything does not start.
 */
export async function startBuildEnvironment(options: BuildOptions): Promise<BuildEnvironment> {
  const { config, ticket, runId } = options;
  const build = config.build;
  if (!build)
    throw new ConfigError("BUILD_NOT_CONFIGURED", "`build` is not configured in .qa/qa.project.yaml.", {});
  const exec = options.exec ?? execCommand;
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const labels = labelsFor(ticket, runId);
  const project = projectName(ticket, runId);
  const services = Object.entries(config.services);
  const containerized = services.filter(([, s]) => s.kind !== "process");
  const processes = services.filter(([, s]) => s.kind === "process");
  const overlay = join(options.envDir, "compose.overlay.yml");
  const composeArgs = (...rest: string[]): string[] => [
    "compose",
    "--project-name",
    project,
    ...(build.compose_file ? ["--file", resolve(options.worktree, build.compose_file)] : []),
    "--file",
    overlay,
    ...rest,
  ];
  const children = new Map<string, ChildProcess>();
  const hostPorts = new Map<string, number>();
  const envFiles: string[] = [];
  const logs: string[] = [];
  let composeStarted = false;

  const stop = async (): Promise<{ logs: readonly string[] }> => {
    if (composeStarted) {
      for (const [name, s] of containerized) {
        const svc = s.kind === "compose" ? (s.compose_service ?? name) : name;
        try {
          const { stdout } = await exec("docker", composeArgs("logs", "--no-color", svc), {
            cwd: options.worktree,
            timeoutMs: 60_000,
          });
          const file = join(options.logsDir, `${name}.log`);
          await writeFile(file, stdout, "utf8");
          logs.push(file);
        } catch {
          // A service that never started has no logs.
        }
      }
      await exec("docker", composeArgs("down", "--volumes", "--remove-orphans"), {
        cwd: options.worktree,
        timeoutMs: 180_000,
      }).catch(() => undefined);
      composeStarted = false;
    }
    for (const child of children.values()) child.kill("SIGTERM");
    children.clear();
    await Promise.all(envFiles.map((f) => rm(f, { force: true })));
    return { logs };
  };

  try {
    await mkdir(options.envDir, { recursive: true, mode: 0o700 });
    await mkdir(options.logsDir, { recursive: true });
    for (const [name] of processes) hostPorts.set(name, await freePort());

    // Endpoints as seen from inside the compose network.
    const inNetwork: Record<string, Endpoint> = {};
    for (const [name, s] of services) {
      if (s.kind === "compose") inNetwork[name] = { host: s.compose_service ?? name, port: s.port };
      else if (s.kind === "stub") inNetwork[name] = { host: name, port: STUB_IMAGES[s.engine]?.port ?? 8080 };
      else inNetwork[name] = { host: "host.docker.internal", port: hostPorts.get(name) ?? 0 };
    }

    if (containerized.length > 0) {
      const overlayServices: Record<string, unknown> = {};
      for (const [name, s] of containerized) {
        const { vars } = await resolveServiceEnv(
          s.env,
          { svc: inNetwork },
          options.resolveSecret,
          options.overrides?.[name],
        );
        const envFile = join(options.envDir, `${name}.env`);
        await writeFile(envFile, toDotenv(vars), { encoding: "utf8", mode: 0o600 });
        await chmod(envFile, 0o600);
        envFiles.push(envFile);
        if (s.kind === "compose") {
          overlayServices[s.compose_service ?? name] = {
            ports: [`127.0.0.1::${String(s.port)}`],
            env_file: [envFile],
            labels,
          };
        } else if (s.kind === "stub") {
          const stub = STUB_IMAGES[s.engine];
          if (!stub) throw new ConfigError("STUB_ENGINE_UNKNOWN", `Unknown stub engine ${s.engine}.`, {});
          overlayServices[name] = {
            image: stub.image,
            ports: [`127.0.0.1::${String(stub.port)}`],
            volumes: [`${resolve(options.qaDir, s.mappings)}:${stub.mount}:ro`],
            env_file: [envFile],
            labels,
          };
        }
      }
      // Volumes declared by the project get labels too, so cleanup can find them (REQ-WS-02/AC1).
      let volumes: Record<string, unknown> = {};
      if (build.compose_file) {
        const base = parse(await readFile(resolve(options.worktree, build.compose_file), "utf8")) as {
          volumes?: Record<string, unknown>;
        } | null;
        volumes = Object.fromEntries(Object.keys(base?.volumes ?? {}).map((v) => [v, { labels }]));
      }
      await writeFile(
        overlay,
        stringify({
          services: overlayServices,
          networks: { default: { labels } },
          ...(Object.keys(volumes).length > 0 ? { volumes } : {}),
        }),
        { encoding: "utf8", mode: 0o600 },
      );
      composeStarted = true;
      await exec("docker", composeArgs("up", "--detach", "--build"), {
        cwd: options.worktree,
        timeoutMs: 900_000,
      });
      // REQ-CFG-05/AC2: the containers have their environment; the files are not needed any more.
      await Promise.all(envFiles.map((f) => rm(f, { force: true })));
      for (const [name, s] of containerized) {
        const svc = s.kind === "compose" ? (s.compose_service ?? name) : name;
        const containerPort =
          s.kind === "compose" ? s.port : (STUB_IMAGES[s.kind === "stub" ? s.engine : ""]?.port ?? 8080);
        const { stdout } = await exec("docker", composeArgs("port", svc, String(containerPort)), {
          cwd: options.worktree,
        });
        const port = Number(/:(\d+)\s*$/.exec(stdout.trim())?.[1]);
        if (!Number.isInteger(port) || port <= 0)
          throw new AdapterError("BUILD_PORT_UNKNOWN", `No published port for ${name}.`, { service: name });
        hostPorts.set(name, port);
      }
    }

    // Endpoints as seen from the host (managed processes and the test runner).
    const onHost: Record<string, Endpoint> = Object.fromEntries(
      services.map(([name]) => [name, { host: "127.0.0.1", port: hostPorts.get(name) ?? 0 }]),
    );
    for (const [name, s] of processes) {
      if (s.kind !== "process") continue;
      const port = hostPorts.get(name) ?? 0;
      const { vars } = await resolveServiceEnv(
        s.env,
        { svc: onHost, port },
        options.resolveSecret,
        options.overrides?.[name],
      );
      const { renderTemplate } = await import("@qajitsu/core");
      const [cmd, ...args] = s.command.map((part) => renderTemplate(part, { svc: onHost, port }));
      const log = createWriteStream(join(options.logsDir, `${name}.log`));
      logs.push(join(options.logsDir, `${name}.log`));
      const child = spawn(cmd ?? "", args, {
        cwd: resolve(options.worktree, s.cwd ?? "."),
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: process.env["HOME"] ?? "",
          PORT: String(port),
          ...vars,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.pipe(log);
      child.stderr.pipe(log);
      children.set(name, child);
    }

    // REQ-ENV-04/AC1: readiness per service with its timeout.
    for (const [name, s] of services) {
      const health =
        s.health ?? (s.kind === "stub" ? { http: "/__admin/mappings", timeout_s: 60 } : undefined);
      if (!health) continue;
      const port = hostPorts.get(name) ?? 0;
      const ready = await waitFor(
        async () => {
          if (children.get(name)?.exitCode !== null && children.has(name)) return false;
          if (health.http)
            return (
              (
                await fetch(`http://127.0.0.1:${String(port)}${health.http}`, {
                  signal: AbortSignal.timeout(2000),
                })
              ).status < 400
            );
          if (health.port) return tcpOpen(port);
          const text =
            s.kind === "process"
              ? await readFile(join(options.logsDir, `${name}.log`), "utf8")
              : (
                  await exec(
                    "docker",
                    composeArgs(
                      "logs",
                      "--no-color",
                      s.kind === "compose" ? (s.compose_service ?? name) : name,
                    ),
                    { cwd: options.worktree },
                  )
                ).stdout;
          return new RegExp(health.log ?? "$^").test(text);
        },
        health.timeout_s * 1000,
        sleep,
      );
      if (!ready)
        throw new BuildStartError(
          "BUILD_START_FAILED",
          `Service ${name} did not become ready within ${String(health.timeout_s)} s.`,
          { service: name },
        );
    }

    const baseUrl = `http://127.0.0.1:${String(hostPorts.get(build.base_service) ?? 0)}`;
    // REQ-ENV-04/AC2: seed hook after readiness.
    if (build.seed) {
      const hook = resolve(options.qaDir, build.seed);
      const [cmd, args] = /\.(mjs|cjs|js)$/.test(hook) ? [process.execPath, [hook]] : [hook, []];
      await exec(cmd, args, { cwd: options.worktree, timeoutMs: 120_000, env: { BASE_URL: baseUrl } }).catch(
        (error: unknown) => {
          throw new BuildStartError("BUILD_START_FAILED", `Seed hook ${build.seed ?? ""} failed.`, {
            stderr: stderrOf(error).slice(-2000),
          });
        },
      );
    }
    return {
      baseUrl,
      services: Object.fromEntries(
        services.map(([name, s]) => [
          name,
          { kind: s.kind, url: `http://127.0.0.1:${String(hostPorts.get(name) ?? 0)}` },
        ]),
      ),
      stubs: services
        .filter(([, s]) => s.kind === "stub")
        .map(([name, s]) => `${name} (${s.kind === "stub" ? s.engine : ""})`),
      stop,
    };
  } catch (error) {
    const { logs: collected } = await stop();
    if (error instanceof BuildStartError)
      throw new BuildStartError(error.code, error.message, { ...error.context, logs: collected });
    throw new BuildStartError(
      "BUILD_START_FAILED",
      `The environment did not start: ${error instanceof Error ? error.message : String(error)}`,
      {
        logs: collected,
        stderr: stderrOf(error).slice(-2000),
      },
    );
  }
}
