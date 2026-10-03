import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  AdapterError,
  ConfigError,
  renderTemplate,
  resolveServiceEnv,
  toDotenv,
  type Endpoint,
  type ProjectConfig,
  type ServiceConfig,
} from "@qajitsu/core";
import { parse, stringify } from "yaml";
import { checkComposeModel } from "./compose-safety.js";

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
        // Never the whole parent environment: the compose file and the seed hook come from the code
        // under test and must not see QAJitsu's own credentials (compose interpolates ${VAR}).
        env: { ...baseEnv(), ...options.env },
      },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(new Error(`${cmd} ${args[0] ?? ""} failed`), { stderr }));
        else resolvePromise({ stdout, stderr });
      },
    );
  });

const PASSED_THROUGH = [
  "PATH",
  "HOME",
  "TMPDIR",
  "USER",
  "LANG",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
];

/** The only parent variables passed to docker, the seed hook and managed processes. */
const baseEnv = (): Record<string, string> =>
  Object.fromEntries(
    PASSED_THROUGH.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k] ?? ""]])),
  );

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
  /** Masks secrets in service and seed logs before they are written (invariant 8). */
  readonly mask?: (text: string) => string;
}

/** A started build environment. */
export interface BuildEnvironment {
  readonly baseUrl: string;
  /** Compose project name (REQ-WS-02/AC2). */
  readonly project: string;
  /** Host ports by service, recorded in `run.json` for `qajitsu env render` and cleanup. */
  readonly ports: Readonly<Record<string, number>>;
  readonly services: Readonly<Record<string, { readonly kind: ServiceConfig["kind"]; readonly url: string }>>;
  /** Stubbed services, listed in the report (REQ-ENV-05/AC2). */
  readonly stubs: readonly string[];
  /**
   * Writes service logs to `logs/` and stops what this run started (REQ-WS-03). With `keep` the
   * containers stay up for debugging (`qajitsu clean` removes them later); managed processes always stop.
   */
  stop(options?: { readonly keep?: boolean }): Promise<{ readonly logs: readonly string[] }>;
}

/** Start failure with the service logs collected so far (REQ-ENV-04/AC3). */
export class BuildStartError extends AdapterError {}

const STUB_IMAGES: Record<string, { image: string; port: number; mount: string }> = {
  wiremock: { image: "wiremock/wiremock:3.9.1", port: 8080, mount: "/home/wiremock/mappings" },
  mockoon: { image: "mockoon/cli:9.1.0", port: 3000, mount: "/data" },
};

/** Container port of a containerised service. */
const containerPort = (s: ServiceConfig): number =>
  s.kind === "compose" ? s.port : s.kind === "stub" ? (STUB_IMAGES[s.engine]?.port ?? 8080) : 0;

/**
 * Endpoints of every service as seen from inside the compose network and from the host.
 *
 * @param config - Project configuration.
 * @param hostPorts - Host port per service.
 */
export function endpointsFor(
  config: ProjectConfig,
  hostPorts: Readonly<Record<string, number>>,
): { inNetwork: Record<string, Endpoint>; onHost: Record<string, Endpoint> } {
  const inNetwork: Record<string, Endpoint> = {};
  const onHost: Record<string, Endpoint> = {};
  for (const [name, s] of Object.entries(config.services)) {
    onHost[name] = { host: "127.0.0.1", port: hostPorts[name] ?? 0 };
    inNetwork[name] =
      s.kind === "compose"
        ? { host: s.compose_service ?? name, port: s.port }
        : s.kind === "stub"
          ? { host: name, port: containerPort(s) }
          : { host: "host.docker.internal", port: hostPorts[name] ?? 0 };
  }
  return { inNetwork, onHost };
}

/**
 * Writes one `<service>.env` per service with permissions 0600 (REQ-CFG-05/AC1, AC3). Containers see
 * in-network endpoints, processes see host endpoints.
 *
 * @returns The files written; the caller deletes them (REQ-CFG-05/AC2).
 */
export async function writeEnvFiles(options: {
  readonly config: ProjectConfig;
  readonly envDir: string;
  readonly hostPorts: Readonly<Record<string, number>>;
  readonly resolveSecret: (reference: string) => Promise<string>;
  readonly overrides?: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined;
  readonly only?: (service: ServiceConfig) => boolean;
}): Promise<string[]> {
  const { inNetwork, onHost } = endpointsFor(options.config, options.hostPorts);
  await mkdir(options.envDir, { recursive: true, mode: 0o700 });
  if ((await lstat(options.envDir)).isSymbolicLink())
    throw new ConfigError("ENV_DIR_SYMLINK", "The run's env/ folder must not be a symbolic link.", {});
  const files: string[] = [];
  for (const [name, s] of Object.entries(options.config.services)) {
    if (options.only && !options.only(s)) continue;
    const { vars } = await resolveServiceEnv(
      s.env,
      s.kind === "process" ? { svc: onHost, port: options.hostPorts[name] } : { svc: inNetwork },
      options.resolveSecret,
      options.overrides?.[name],
    );
    const file = join(options.envDir, `${name}.env`);
    // Removed first and created exclusively, so a planted symlink is never followed.
    await rm(file, { force: true });
    await writeFile(file, toDotenv(vars), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(file, 0o600);
    files.push(file);
  }
  return files;
}

/** Resolves a path in the worktree and refuses one that leaves it, also through symlinks. */
const insideWorktree = async (worktree: string, file: string): Promise<string> => {
  const root = await realpath(worktree);
  const target = await realpath(resolve(worktree, file)).catch(() => resolve(worktree, file));
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new BuildStartError("BUILD_START_FAILED", `${file} points outside the worktree.`, {});
  return target;
};

/** Given and real paths of the allowed roots (macOS tmp folders are symlinks). */
const rootsOf = async (dirs: readonly string[]): Promise<string[]> => [
  ...dirs,
  ...(await Promise.all(dirs.map((d) => realpath(d).catch(() => d)))),
];

const waitFor = async (
  check: () => Promise<boolean>,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  gone: () => boolean = () => false,
): Promise<boolean> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return true;
    // A managed process that exited will never become ready.
    if (gone()) return false;
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
  const mask = options.mask ?? ((text: string) => text);
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const labels = labelsFor(ticket, runId);
  const project = projectName(ticket, runId);
  const services = Object.entries(config.services);
  const containerized = services.filter(([, s]) => s.kind !== "process");
  const processes = services.filter(([, s]) => s.kind === "process");
  const overlay = join(options.envDir, "compose.overlay.yml");
  const composeFile = build.compose_file
    ? await insideWorktree(options.worktree, build.compose_file)
    : undefined;
  const composeArgs = (...rest: string[]): string[] => [
    "compose",
    "--project-name",
    project,
    ...(composeFile ? ["--file", composeFile] : []),
    "--file",
    overlay,
    ...rest,
  ];
  const children = new Map<string, ChildProcess>();
  const hostPorts = new Map<string, number>();
  const envFiles: string[] = [];
  const logs: string[] = [];
  let composeStarted = false;

  const stop = async (stopOptions: { keep?: boolean } = {}): Promise<{ logs: readonly string[] }> => {
    if (composeStarted) {
      for (const [name, s] of containerized) {
        const svc = s.kind === "compose" ? (s.compose_service ?? name) : name;
        try {
          const { stdout } = await exec("docker", composeArgs("logs", "--no-color", svc), {
            cwd: options.worktree,
            timeoutMs: 60_000,
          });
          const file = join(options.logsDir, `${name}.log`);
          await writeFile(file, mask(stdout), "utf8");
          logs.push(file);
        } catch {
          // A service that never started has no logs.
        }
      }
      if (stopOptions.keep !== true) {
        await exec("docker", composeArgs("down", "--volumes", "--remove-orphans"), {
          cwd: options.worktree,
          timeoutMs: 180_000,
        }).catch(() => undefined);
      }
      composeStarted = false;
    }
    for (const child of children.values()) child.kill("SIGTERM");
    children.clear();
    // Process logs were streamed as written; mask them now that the process is gone.
    for (const [name] of processes) {
      const file = join(options.logsDir, `${name}.log`);
      const text = await readFile(file, "utf8").catch(() => undefined);
      if (text !== undefined) await writeFile(file, mask(text), "utf8");
    }
    await Promise.all(envFiles.map((f) => rm(f, { force: true })));
    return { logs };
  };

  try {
    await mkdir(options.envDir, { recursive: true, mode: 0o700 });
    await mkdir(options.logsDir, { recursive: true });
    for (const [name] of processes) hostPorts.set(name, await freePort());

    if (containerized.length > 0) {
      const overlayServices: Record<string, unknown> = {};
      envFiles.push(
        ...(await writeEnvFiles({
          config,
          envDir: options.envDir,
          hostPorts: Object.fromEntries(hostPorts),
          resolveSecret: options.resolveSecret,
          overrides: options.overrides,
          only: (svc) => svc.kind !== "process",
        })),
      );
      for (const [name, s] of containerized) {
        const envFile = join(options.envDir, `${name}.env`);
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
      if (composeFile) {
        let base: { volumes?: Record<string, unknown> } | null;
        try {
          base = parse(await readFile(composeFile, "utf8")) as typeof base;
        } catch {
          // No parser detail: it could quote file content into results and reports.
          throw new BuildStartError(
            "BUILD_START_FAILED",
            `${build.compose_file ?? ""} is not valid YAML.`,
            {},
          );
        }
        volumes = Object.fromEntries(Object.keys(base?.volumes ?? {}).map((v) => [v, { labels }]));
      }
      const writeOverlay = (withEnvFiles: boolean): Promise<void> =>
        writeFile(
          overlay,
          stringify({
            services: withEnvFiles
              ? overlayServices
              : Object.fromEntries(
                  Object.entries(overlayServices).map(([k, v]) => [
                    k,
                    Object.fromEntries(
                      Object.entries(v as Record<string, unknown>).filter(([key]) => key !== "env_file"),
                    ),
                  ]),
                ),
            networks: { default: { labels } },
            ...(Object.keys(volumes).length > 0 ? { volumes } : {}),
          }),
          { encoding: "utf8", mode: 0o600 },
        );
      await writeOverlay(true);
      // The compose file belongs to the change under test: check its effective model first.
      const model = await exec("docker", composeArgs("config", "--format", "json"), {
        cwd: options.worktree,
        timeoutMs: 120_000,
      }).catch(() => {
        throw new BuildStartError("BUILD_START_FAILED", "docker compose config failed.", {});
      });
      let parsedModel: unknown;
      try {
        parsedModel = JSON.parse(model.stdout) as unknown;
      } catch {
        throw new BuildStartError("BUILD_START_FAILED", "docker compose config did not return JSON.", {});
      }
      const unsafe = checkComposeModel(parsedModel, await rootsOf([options.worktree, options.qaDir]));
      if (unsafe.length > 0) {
        await Promise.all(envFiles.map((f) => rm(f, { force: true })));
        throw new BuildStartError(
          "BUILD_START_FAILED",
          `The compose file was rejected: ${unsafe.join("; ")}.`,
          {
            problems: unsafe,
          },
        );
      }
      composeStarted = true;
      try {
        await exec("docker", composeArgs("up", "--detach", "--build"), {
          cwd: options.worktree,
          timeoutMs: 900_000,
        });
      } finally {
        // REQ-CFG-05/AC2: the containers have their environment; the files are not needed any more.
        // The overlay is rewritten without them so that logs, port and down still parse it.
        await Promise.all(envFiles.map((f) => rm(f, { force: true })));
        await writeOverlay(false);
      }
      for (const [name, s] of containerized) {
        const svc = s.kind === "compose" ? (s.compose_service ?? name) : name;
        const { stdout } = await exec("docker", composeArgs("port", svc, String(containerPort(s))), {
          cwd: options.worktree,
        });
        const port = Number(/:(\d+)\s*$/.exec(stdout.trim())?.[1]);
        if (!Number.isInteger(port) || port <= 0)
          throw new AdapterError("BUILD_PORT_UNKNOWN", `No published port for ${name}.`, { service: name });
        hostPorts.set(name, port);
      }
    }

    // Endpoints as seen from the host (managed processes and the test runner).
    const { onHost } = endpointsFor(config, Object.fromEntries(hostPorts));
    for (const [name, s] of processes) {
      if (s.kind !== "process") continue;
      const port = hostPorts.get(name) ?? 0;
      const { vars } = await resolveServiceEnv(
        s.env,
        { svc: onHost, port },
        options.resolveSecret,
        options.overrides?.[name],
      );
      const [cmd, ...args] = s.command.map((part) => renderTemplate(part, { svc: onHost, port }));
      const log = createWriteStream(join(options.logsDir, `${name}.log`));
      logs.push(join(options.logsDir, `${name}.log`));
      const child = spawn(cmd ?? "", args, {
        cwd: resolve(options.worktree, s.cwd ?? "."),
        env: {
          ...baseEnv(),
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
          if (health.http)
            return (
              (
                await fetch(`http://127.0.0.1:${String(port)}${health.http}`, {
                  signal: AbortSignal.timeout(2000),
                  redirect: "manual",
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
        () => {
          const child = children.get(name);
          return child !== undefined && (child.exitCode !== null || child.signalCode !== null);
        },
      );
      if (!ready)
        throw new BuildStartError(
          "BUILD_START_FAILED",
          children.get(name)?.exitCode != null
            ? `Service ${name} exited with code ${String(children.get(name)?.exitCode)} before it was ready.`
            : `Service ${name} did not become ready within ${String(health.timeout_s)} s.`,
          { service: name },
        );
    }

    const baseUrl = `http://127.0.0.1:${String(hostPorts.get(build.base_service) ?? 0)}`;
    // REQ-ENV-04/AC2: seed hook after readiness, with the base service's variables (it seeds that
    // service) and the run marker QAJITSU_RUN for the data it creates. Output goes to logs/seed.log.
    if (build.seed) {
      const hook = resolve(options.qaDir, build.seed);
      const [cmd, args] = /\.(mjs|cjs|js)$/.test(hook) ? [process.execPath, [hook]] : [hook, []];
      const baseService = config.services[build.base_service];
      const { vars } = baseService
        ? await resolveServiceEnv(
            baseService.env,
            { svc: onHost, port: hostPorts.get(build.base_service) },
            options.resolveSecret,
            options.overrides?.[build.base_service],
          )
        : { vars: {} };
      const seedLog = join(options.logsDir, "seed.log");
      logs.push(seedLog);
      const output = await exec(cmd, args, {
        cwd: options.worktree,
        timeoutMs: 120_000,
        env: { ...vars, BASE_URL: baseUrl, QAJITSU_RUN: runId, QAJITSU_TICKET: ticket },
      }).catch(async (error: unknown) => {
        await writeFile(seedLog, mask(stderrOf(error)), "utf8");
        throw new BuildStartError("BUILD_START_FAILED", `Seed hook ${build.seed ?? ""} failed.`, {});
      });
      await writeFile(seedLog, mask(`${output.stdout}${output.stderr}`), "utf8");
    }
    return {
      baseUrl,
      project,
      ports: Object.fromEntries(hostPorts),
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
