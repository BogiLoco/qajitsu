import { writeEnvFiles } from "@qajitsu/adapter-env-compose";
import { QajitsuError, checkBuildConfig, resolveEnvironment, type EnvProblem } from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import { createCliSecretResolver, type RuntimePorts } from "../adapters.js";
import { loadProject } from "../project.js";
import { openSession, type ModelPorts } from "../session.js";
import type { CommandIO } from "./fetch.js";

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
    const project = await loadProject(io.cwd);
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
