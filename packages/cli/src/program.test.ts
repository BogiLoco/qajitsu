import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatDoctor, runDoctor } from "./doctor.js";
import { createProgram } from "./program.js";
import { readVersion } from "./version.js";

function run(args: string[], cwd = mkdtempSync(join(tmpdir(), "qj-cli-")), nodeVersion = "v22.22.0") {
  let out = "";
  let err = "";
  let exitCode = 0;
  const program = createProgram("1.2.3", {
    write: (t) => (out += t),
    writeError: (t) => (err += t),
    cwd,
    nodeVersion,
    setExitCode: (c) => (exitCode = c),
  }).exitOverride();
  return program.parseAsync(["node", "qajitsu", ...args]).then(
    () => ({ out, err, exitCode }),
    (error: unknown) => ({ out, err, exitCode, error }),
  );
}

describe("qajitsu CLI (REQ-GEN-05)", () => {
  it("prints the version", async () => {
    const result = await run(["--version"]);
    expect(result.out.trim()).toBe("1.2.3");
  });

  it("doctor fails with exit code 3 without project config", async () => {
    const result = await run(["doctor"]);
    expect(result.out).toContain("✘ project config");
    expect(result.exitCode).toBe(3);
  });

  it("doctor passes with project config and a supported Node.js", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "qj-cli-"));
    mkdirSync(join(cwd, ".qa"));
    writeFileSync(join(cwd, ".qa", "qa.project.yaml"), "project: demo\n");
    const result = await run(["doctor"], cwd);
    expect(result.out).toContain("✔ node");
    expect(result.exitCode).toBe(0);
  });

  it("rejects unknown commands", async () => {
    const result = await run(["frobnicate", "SHOP-1"]);
    expect(result.err).toContain("unknown command");
  });

  it("reads its own package version", () => {
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("runDoctor (REQ-GEN-03)", () => {
  it.each([
    ["v22.12.0", true],
    ["v24.1.0", true],
    ["v22.11.9", false],
    ["v20.19.0", false],
  ])("node %s ok=%s", (nodeVersion, ok) => {
    expect(runDoctor({ nodeVersion, hasProjectConfig: true })[0]?.ok).toBe(ok);
  });

  it("formats one line per check", () => {
    expect(formatDoctor([{ name: "a", ok: true, detail: "d" }])).toBe("✔ a: d");
  });
});
