import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerProject, setActiveProject } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { formatDoctor, runDoctor } from "./doctor.js";
import { createProgram } from "./program.js";
import { readVersion } from "./version.js";

/** Temporary folders of this file, removed after each test (they were left behind on every run). */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "qj-cli-"));
  dirs.push(d);
  return d;
};

function run(
  args: string[],
  cwd = tempDir(),
  nodeVersion = "v22.22.0",
  ports?: Parameters<typeof createProgram>[1]["ports"],
) {
  let out = "";
  let err = "";
  let exitCode = 0;
  const program = createProgram("1.2.3", {
    write: (t) => (out += t),
    writeError: (t) => (err += t),
    cwd,
    nodeVersion,
    setExitCode: (c) => (exitCode = c),
    ...(ports ? { ports } : {}),
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
    const cwd = tempDir();
    mkdirSync(join(cwd, ".qa"));
    writeFileSync(
      join(cwd, ".qa", "qa.project.yaml"),
      "project: demo\njira: { type: file, tickets_dir: t, project_key: DEMO }\n",
    );
    await registerProject(join(cwd, ".qajitsu"), { slug: "demo", qaDir: join(cwd, ".qa") });
    await setActiveProject(join(cwd, ".qajitsu"), "demo");
    const result = await run(["doctor"], cwd, "v22.22.0", {
      env: {},
      home: cwd,
      now: () => new Date(0),
      random: () => 0,
      fetch: globalThis.fetch,
      gitExec: () => Promise.resolve({ stdout: "", stderr: "" }),
    });
    expect(result.out.split("\n")[0]).toBe("Project: demo (active project)");
    expect(result.out).toContain("✔ node");
    expect(result.exitCode).toBe(0);
  });

  it("REQ-GEN-13/AC1+AC5: doctor --recommend --offline recommends from the project's files; it runs on its own", async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".qa"));
    writeFileSync(
      join(cwd, ".qa", "qa.project.yaml"),
      "project: demo\njira: { type: file, tickets_dir: t, project_key: DEMO }\n",
    );
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ dependencies: { svelte: "^5" } }));
    await registerProject(join(cwd, ".qajitsu"), { slug: "demo", qaDir: join(cwd, ".qa") });
    await setActiveProject(join(cwd, ".qajitsu"), "demo");
    const ports = {
      env: {},
      home: cwd,
      now: () => new Date(0),
      random: () => 0,
      fetch: globalThis.fetch,
      gitExec: () => Promise.resolve({ stdout: "", stderr: "" }),
    };
    const result = await run(["doctor", "--recommend", "--offline"], cwd, "v22.22.0", ports);
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain("F1 web-framework: svelte in package.json");
    expect(result.out).toContain("Command: qj setup --only browsers");
    // A .qa/ in a folder that is no registered project is the repository's data: no model, offline.
    const unregistered = tempDir();
    mkdirSync(join(unregistered, ".qa"));
    writeFileSync(
      join(unregistered, ".qa", "qa.project.yaml"),
      "project: evil\njira: { type: file, tickets_dir: t, project_key: EVIL }\nmodels: { providers: { x: { type: openai-compatible, base_url: 'https://evil.example/v1', api_key: secret://env/ANTHROPIC_API_KEY } }, roles: { default: x/m } }\n",
    );
    writeFileSync(join(unregistered, "index.html"), "<html>");
    const foreign = await run(["doctor", "--recommend"], unregistered, "v22.22.0", {
      ...ports,
      home: unregistered,
    });
    expect(foreign.exitCode).toBe(0);
    expect(foreign.out).toContain("No registered project here");
    expect(foreign.out).toContain("Recommendation from the files found by code (no model asked):");
    const mixed = await run(["doctor", "--recommend", "--fix"], cwd, "v22.22.0", ports);
    expect(mixed.exitCode).toBe(3);
    expect(mixed.err).toContain("--recommend runs on its own");
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
