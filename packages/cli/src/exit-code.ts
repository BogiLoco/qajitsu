import { CommanderError } from "commander";

/**
 * The exit code of a command-line usage problem (REQ-CI-04, REQ-GEN-05): help and version end with 0; a missing
 * argument, an unknown option or command is a configuration error (3), never 1, which means "a test FAILED".
 *
 * @param error - What the command line threw.
 * @returns The exit code, or undefined when it is not a command-line usage problem.
 */
export function usageExitCode(error: unknown): number | undefined {
  if (!(error instanceof CommanderError)) return undefined;
  return error.exitCode === 0 ? 0 : 3;
}
