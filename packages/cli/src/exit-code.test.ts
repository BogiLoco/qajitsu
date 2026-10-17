import { describe, expect, it } from "vitest";
import { usageExitCode } from "./exit-code.js";
import { createProgram } from "./program.js";

const program = () =>
  createProgram("1.0.0", {
    write: () => undefined,
    writeError: () => undefined,
    cwd: process.cwd(),
    nodeVersion: process.version,
    setExitCode: () => undefined,
  });

const thrown = async (args: string[]): Promise<unknown> =>
  program()
    .parseAsync(["node", "qj", ...args])
    .then(
      () => undefined,
      (e: unknown) => e,
    );

describe("exit codes of command-line usage problems (REQ-CI-04, REQ-GEN-05)", () => {
  it("REQ-CI-04: a missing argument, an unknown option or command exits 3, never 1 (which means a FAILED test)", async () => {
    expect(usageExitCode(await thrown(["init"]))).toBe(3);
    expect(usageExitCode(await thrown(["run", "--no-such-flag", "DEMO-1"]))).toBe(3);
    expect(usageExitCode(await thrown(["no-such-command"]))).toBe(3);
  });

  it("REQ-GEN-05: help and version exit 0; other errors are not usage problems", async () => {
    expect(usageExitCode(await thrown(["--version"]))).toBe(0);
    expect(usageExitCode(await thrown(["init", "--help"]))).toBe(0);
    expect(usageExitCode(new Error("boom"))).toBeUndefined();
  });

  it("REQ-CI-04: a group command without its subcommand says which ones exist and exits 3", async () => {
    for (const [group, sub] of [
      ["work", "reset"],
      ["env", "check"],
      ["knowledge", "add"],
      ["audit", "verify"],
      ["telemetry", "export"],
      ["ci", "detect"],
      ["baseline", "accept"],
    ] as const) {
      let err = "";
      let code: number | undefined;
      await createProgram("1.0.0", {
        write: () => undefined,
        writeError: (t) => (err += t),
        cwd: process.cwd(),
        nodeVersion: process.version,
        setExitCode: (c) => (code = c),
      })
        .exitOverride()
        .parseAsync(["node", "qj", group]);
      expect(code, group).toBe(3);
      // Exploratory testing F4: it said nothing about what was missing.
      expect(err, group).toMatch(new RegExp(`^error: '${group}' needs a command: .*\\b${sub}\\b`));
    }
  });
});
