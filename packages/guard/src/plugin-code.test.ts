import { describe, expect, it } from "vitest";
import { checkPluginCode, pluginCodeProblems } from "./plugin-code.js";

const file = (text: string, path = "dist/index.js") => ({ path, text });

describe("plugin code against its permissions (REQ-GEN-11/AC9, ADR-0015)", () => {
  it("REQ-GEN-11/AC9: a plugin that only uses what it declares passes", () => {
    const code = [
      'import { readFile } from "node:fs/promises";',
      'import { request } from "https";',
      "const key = process.env.HOME;",
      "export const x = 1;",
    ].join("\n");
    expect(checkPluginCode([file(code)], ["filesystem", "network", "environment"])).toEqual([]);
  });

  it("REQ-GEN-11/AC9: Node modules a permission does not cover are named with the line and the permission", () => {
    const code = [
      'import { spawn } from "node:child_process";',
      'const net = await import("node:net");',
      'const fs = require("fs");',
      'export { Worker } from "worker_threads";',
    ].join("\n");
    expect(checkPluginCode([file(code)], [])).toEqual([
      { file: "dist/index.js", line: 1, use: "node:child_process", needs: "exec" },
      { file: "dist/index.js", line: 2, use: "node:net", needs: "network" },
      { file: "dist/index.js", line: 3, use: "node:fs", needs: "filesystem" },
      { file: "dist/index.js", line: 4, use: "node:worker_threads", needs: "exec" },
    ]);
  });

  it("REQ-GEN-11/AC4: reading the process environment and the global fetch need their permissions", () => {
    const code = ['const t = process.env["JIRA_TOKEN"];', "await globalThis.fetch(url);"].join("\n");
    expect(checkPluginCode([file(code)], [])).toEqual([
      { file: "dist/index.js", line: 1, use: "process.env", needs: "environment" },
      { file: "dist/index.js", line: 2, use: "global fetch", needs: "network" },
    ]);
  });

  it("REQ-GEN-11/AC9: the frozen plan is never referred to, whatever the permissions", () => {
    const code = 'const p = join(run, "plan.approved.yaml");';
    expect(checkPluginCode([file(code)], ["filesystem", "network", "exec", "environment"])).toEqual([
      { file: "dist/index.js", line: 1, use: "plan.approved.yaml", needs: "never" },
    ]);
  });

  it("REQ-GEN-11/AC9: type-only imports, comments and other packages are not uses", () => {
    const code = [
      'import type { ChildProcess } from "node:child_process";',
      '// import { spawn } from "node:child_process";',
      " * process.env is documented here",
      'import { z } from "zod";',
      'import { createMasker } from "@qajitsu/steps";',
      "const fetch = deps.fetch; await options.fetch(url);",
    ].join("\n");
    expect(checkPluginCode([file(code, "src/x.ts")], [])).toEqual([]);
  });

  it("REQ-GEN-11/AC9: the problems read as one refusal with the files and permissions", () => {
    expect(pluginCodeProblems([])).toBeUndefined();
    const text = pluginCodeProblems([
      { file: "dist/a.js", line: 3, use: "node:child_process", needs: "exec" },
      { file: "dist/b.js", line: 9, use: "plan.approved.yaml", needs: "never" },
    ]);
    expect(text).toBe(
      "dist/a.js:3 uses node:child_process without the exec permission; dist/b.js:9 refers to plan.approved.yaml, which no plugin may",
    );
  });
});
