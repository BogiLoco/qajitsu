import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { formatDoctor, runDoctor } from "./doctor.js";

/** Output and environment ports, injected for tests. */
export interface ProgramIO {
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly cwd: string;
  readonly nodeVersion: string;
  readonly setExitCode: (code: number) => void;
}

/**
 * Builds the `qajitsu` command (REQ-GEN-05). Only implemented commands are registered;
 * planned ones are listed in docs/requirements/generic.md.
 *
 * @param version - Version printed by `--version`.
 * @param io - Output and environment ports.
 */
export function createProgram(version: string, io: ProgramIO): Command {
  const program = new Command()
    .name("qajitsu")
    .description("Agentic QA: Jira ticket in, approved test plan, executed tests and evidence out.")
    .version(version)
    .configureOutput({ writeOut: io.write, writeErr: io.writeError })
    .showHelpAfterError();

  program
    .command("doctor")
    .description("Check that this machine and project are ready for QAJitsu")
    .action(() => {
      const checks = runDoctor({
        nodeVersion: io.nodeVersion,
        hasProjectConfig: existsSync(join(io.cwd, ".qa", "qa.project.yaml")),
      });
      io.write(`${formatDoctor(checks)}\n`);
      io.setExitCode(checks.every((c) => c.ok) ? 0 : 3);
    });

  return program;
}
