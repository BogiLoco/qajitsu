import { writeEnvFiles } from "@qajitsu/adapter-env-compose";
import {
  ConfigError,
  QajitsuError,
  acquireRunLock,
  checkBuildConfig,
  resolveEnvironment,
  type EnvProblem,
} from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import { createCliSecretResolver, type RuntimePorts } from "../adapters.js";
import { loadProject } from "../project.js";
import { openSession, type ModelPorts } from "../session.js";
import { parseOverrides, prepareBuild, removeEnvFiles, type PreparedBuild } from "./build-env.js";
import type { CommandIO } from "./fetch.js";
import type { RunPorts } from "./run.js";

const fail = (io: CommandIO, error: unknown, mask: (t: string) => string): number => {
  const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
  io.writeError(mask(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`));
  return 3;
};

/**
 * `qajitsu env check [--env <profile>]`: lists every missing or invalid variable of the chosen
 * environment profile and of the `--build` configuration without starting anything (REQ-CFG-04/AC1).
 *
 * @returns 0 when complete, 3 when anything is missing or invalid.
 */
export async function runEnvCheck(
  options: { readonly env?: string | undefined },
  io: CommandIO,
  ports: RuntimePorts,
): Promise<number> {
  const masker = createMasker();
  try {
    const project = await loadProject(io.cwd, ports.project);
    const resolveSecret = createCliSecretResolver(project, ports, masker);
    const secretExists = (ref: string): Promise<boolean> =>
      resolveSecret(ref).then(
        () => true,
        () => false,
      );
    const problems: EnvProblem[] = [];
    const selected = options.env ?? project.config.build?.profile ?? project.config.environments.default;
    if (selected !== undefined) {
      try {
        const env = await resolveEnvironment({
          config: project.config,
          qaDir: project.qaDir,
          env: selected,
          ...(options.env === undefined && project.config.build
            ? { buildBaseUrl: "http://127.0.0.1:1" }
            : {}),
        });
        for (const [alias, account] of Object.entries(env.profile.accounts)) {
          for (const [field, value] of Object.entries(account))
            if (typeof value === "string" && value.startsWith("secret://") && !(await secretExists(value)))
              problems.push({
                where: `accounts.${alias}.${field}`,
                problem: `secret ${value} cannot be resolved`,
              });
        }
        io.write(`Environment profile: ${env.name}\n`);
      } catch (error) {
        problems.push({
          where: `environment ${selected}`,
          problem: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (project.config.build) {
      problems.push(
        ...(await checkBuildConfig({ config: project.config, qaDir: project.qaDir, secretExists })),
      );
      io.write(
        `Build: ${String(Object.keys(project.config.services).length)} service(s), base ${project.config.build.base_service}\n`,
      );
    }
    if (problems.length === 0) {
      io.write("✔ configuration complete\n");
      return 0;
    }
    io.write(`${problems.map((p) => `✘ ${p.where}: ${p.problem}`).join("\n")}\n`);
    return 3;
  } catch (error) {
    return fail(io, error, (t) => masker.maskText(t));
  }
}

/**
 * `qajitsu env render <TICKET> [--run <id>]`: recreates the per-service `.env` files of a run with
 * permissions 0600, using the ports recorded by its `--build` (REQ-CFG-05/AC3). They contain secrets
 * and are removed by `qajitsu clean`.
 */
export async function runEnvRender(
  rawKey: string,
  options: { readonly run?: string | undefined },
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
): Promise<number> {
  const masker = createMasker();
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const recorded = (session.ws.record.data["build"] as { ports?: Record<string, number> } | undefined)
      ?.ports;
    const files = await writeEnvFiles({
      config: session.project.config,
      envDir: session.ws.path("env"),
      hostPorts: recorded ?? {},
      resolveSecret: (ref) => session.resolveSecret(ref),
    });
    io.write(`${files.join("\n")}\n`);
    io.write(
      `${String(files.length)} file(s) written (0600)${recorded ? "" : "; no --build ports recorded, ports are 0"}. They contain secrets: remove them with 'qajitsu clean ${session.ws.ticket} --run ${session.ws.runId}'.\n`,
    );
    return 0;
  } catch (error) {
    return fail(io, error, (t) => masker.maskText(t));
  }
}

const SYSTEM = { kind: "system", name: "orchestrator" } as const;

/** Options of `qajitsu env up`. */
export interface EnvUpOptions {
  readonly run?: string | undefined;
  /** `<service>.<VAR>=<value>` overrides of overridable variables, as for `qj run --build`. */
  readonly set?: readonly string[] | undefined;
  /** Leave the containers running and return; `qajitsu clean` removes them. */
  readonly detach?: boolean | undefined;
}

/**
 * `qajitsu env up <TICKET> [--run <id>] [--set ...] [--detach]`: starts the application from the run's
 * worktree exactly as `qj run --build` would, with no agent and no test (REQ-GEN-05/AC2, REQ-ENV-03).
 * Prints the service URLs, then waits for Ctrl+C and stops everything; with `--detach` the containers
 * stay up until `qajitsu clean`. The worktree stays for a later `qj run`; nothing is written to
 * `results/` or `evidence/`.
 *
 * @returns 0 started (and stopped), 2 the environment did not start, 3 configuration or other errors.
 */
export async function runEnvUp(
  rawKey: string,
  options: EnvUpOptions,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts & RunPorts,
): Promise<number> {
  const masker = createMasker();
  const signals = ports.signals ?? process;
  let stopRequested: () => void = () => undefined;
  const onSignal = (): void => {
    stopRequested();
  };
  let release: (() => Promise<void>) | undefined;
  let prepared: PreparedBuild = {};
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const { ws, events, project } = session;
    const overrides = parseOverrides(options.set ?? []);
    const processes = Object.entries(project.config.services).filter(([, s]) => s.kind === "process");
    if (options.detach && processes.length > 0)
      throw new ConfigError(
        "DETACH_WITH_PROCESSES",
        `--detach needs containers only; managed processes stop with this command: ${processes.map(([n]) => n).join(", ")}.`,
        {},
      );
    release = await acquireRunLock(ws.path("run.lock"));
    const stopped = new Promise<void>((resolve) => (stopRequested = resolve));
    signals.on("SIGINT", onSignal);
    signals.on("SIGTERM", onSignal);
    io.write(`Starting the environment from ${project.config.build?.repo ?? "?"}…\n`);
    prepared = await prepareBuild(session, { overrides, exec: ports.buildExec, fetch: ports.fetch });
    const built = prepared.build;
    if (!built) {
      const failure = prepared.failure ?? { message: "unknown start failure", logs: [] };
      events.emit("env", SYSTEM, "env.up", { ok: false, error: masker.maskText(failure.message) });
      await removeEnvFiles(session);
      io.writeError(
        masker.maskText(
          `The environment did not start: ${failure.message}\n${failure.logs.map((l) => `  log: ${l}`).join("\n")}\n`,
        ),
      );
      return 2;
    }
    events.emit("env", SYSTEM, "env.up", { ok: true, project: built.project, stubs: built.stubs });
    await ws.update({
      data: {
        ...ws.record.data,
        build: { project: built.project, ports: built.ports, services: built.services },
      },
    });
    io.write(
      `Environment ${built.project} is up; base URL ${built.baseUrl}\n${Object.entries(built.services)
        .map(([name, s]) => `  ${name}: ${s.url}${built.stubs.includes(name) ? " (stub)" : ""}`)
        .join("\n")}\n`,
    );
    if (options.detach) {
      // Compose no longer needs the env files once the containers run (the overlay was rewritten).
      await removeEnvFiles(session);
      io.write(`Detached; remove it with: qajitsu clean ${ws.ticket} --run ${ws.runId}\n`);
      return 0;
    }
    io.write("Press Ctrl+C to stop.\n");
    await stopped;
    const { logs } = await built.stop();
    prepared = {};
    await removeEnvFiles(session);
    events.emit("env", SYSTEM, "env.down", { project: built.project, logs: logs.length });
    io.write(`Stopped ${built.project}; logs in ${ws.path("logs")}\n`);
    return 0;
  } catch (error) {
    await prepared.build?.stop().catch(() => undefined);
    return fail(io, error, (t) => masker.maskText(t));
  } finally {
    signals.off("SIGINT", onSignal);
    signals.off("SIGTERM", onSignal);
    await release?.();
  }
}
