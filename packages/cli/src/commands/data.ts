import {
  ConfigError,
  QajitsuError,
  RunIdSchema,
  TicketKeySchema,
  createAccountLeases,
  resolveEnvironment,
} from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import { createCliSecretResolver, type RuntimePorts } from "../adapters.js";
import { loadProject } from "../project.js";
import { createTestDataProvider, testDataMarker } from "../test-data.js";
import type { CommandIO } from "./fetch.js";
import { accountHeaders } from "./lanes.js";

/**
 * `qajitsu data clean [ticket] [--run <id>] [--all] [--env <profile>]`: removes the test data crashed or kept runs
 * left in an environment (REQ-EXEC-53/AC2), by marker: one run (`qj-<ticket>-<run>`), every run of a ticket
 * (`qj-<ticket>-`) or, with `--all`, everything QAJitsu created (`qj-`). The project's `test_data.cleanup` request or
 * data hook does the removing.
 *
 * @returns 0 cleaned, 3 errors.
 */
export async function runDataClean(
  rawKey: string | undefined,
  options: {
    readonly run?: string | undefined;
    readonly all?: boolean | undefined;
    readonly env?: string | undefined;
  },
  io: CommandIO,
  ports: RuntimePorts,
): Promise<number> {
  const masker = createMasker();
  try {
    if ((rawKey === undefined) === (options.all !== true))
      throw new ConfigError(
        "DATA_CLEAN_SCOPE",
        "Name a ticket (optionally with --run <id>) or pass --all.",
        {},
      );
    const project = await loadProject(io.cwd, ports.project);
    const config = project.config.test_data;
    if (!config || (!config.cleanup && !config.hook))
      throw new ConfigError(
        "TEST_DATA_NO_CLEANUP",
        "Set test_data.cleanup (a DELETE request with {marker}) or test_data.hook in .qa/qa.project.yaml.",
        {},
      );
    let prefix = "qj-";
    if (rawKey !== undefined) {
      const ticket = TicketKeySchema.parse(rawKey);
      if (options.run !== undefined && !RunIdSchema.safeParse(options.run).success)
        throw new ConfigError("RUN_ID_INVALID", "Expected a run id like 20261003-1046-k7f3.", {});
      prefix = options.run === undefined ? `qj-${ticket}-` : testDataMarker(ticket, options.run);
    }
    const env = await resolveEnvironment({
      config: project.config,
      qaDir: project.qaDir,
      env: options.env ?? project.config.environments.default,
    });
    const resolveSecret = createCliSecretResolver(project, ports, masker);
    const leases = createAccountLeases(env.profile, {
      waitMs: project.config.execution.account_wait_s * 1000,
    });
    const provider = createTestDataProvider({
      config,
      baseUrl: env.baseUrl,
      allowedOrigins: [env.origin],
      fetch: ports.fetch,
      headersFor: accountHeaders(env, leases, {
        fetch: ports.fetch,
        qaDir: project.qaDir,
        resolveSecret,
        registerSecret: (v) => {
          masker.register(v);
        },
      }),
      qaDir: project.qaDir,
    });
    const removed = await provider.cleanup(prefix);
    io.write(
      `Removed the test data marked ${prefix}* in ${env.name}${removed === undefined ? "" : `: ${String(removed)} record(s)`}\n`,
    );
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}
