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

  // Found by mutation testing (REQ-NFR-14): each module's permission, the spellings of an import and where a line
  // stops being a type-only import or a comment.
  it.each([
    ["net", "network"],
    ["http", "network"],
    ["https", "network"],
    ["http2", "network"],
    ["tls", "network"],
    ["dgram", "network"],
    ["dns", "network"],
    ["dns/promises", "network"],
    ["child_process", "exec"],
    ["worker_threads", "exec"],
    ["cluster", "exec"],
    ["fs", "filesystem"],
    ["fs/promises", "filesystem"],
  ] as const)("REQ-GEN-11/AC9: node:%s needs the %s permission", (name, needs) => {
    const code = `import x from "node:${name}";`;
    expect(checkPluginCode([file(code)], [])).toEqual([
      { file: "dist/index.js", line: 1, use: `node:${name}`, needs },
    ]);
    expect(checkPluginCode([file(code)], [needs])).toEqual([]);
  });

  it("REQ-GEN-11/AC9: minified and spaced imports are found as well", () => {
    const code = [
      'import x from"node:fs";',
      'const a = await import ("node:net");',
      'const b = await import( "node:tls");',
      'const c = require ("child_process");',
      'const d = require( "cluster");',
    ].join("\n");
    expect(checkPluginCode([file(code)], []).map((v) => [v.line, v.use])).toEqual([
      [1, "node:fs"],
      [2, "node:net"],
      [3, "node:tls"],
      [4, "node:child_process"],
      [5, "node:cluster"],
    ]);
  });

  it("REQ-GEN-11/AC9: only a line that starts as a type-only import or a comment is skipped", () => {
    const code = [
      '  import  type { Stats } from "node:fs";',
      '   // require("node:net") in a comment',
      'const fs = require("fs"); export type T = 1;',
      'const net = require("net"); // the network',
    ].join("\n");
    expect(checkPluginCode([file(code)], []).map((v) => [v.line, v.use])).toEqual([
      [3, "node:fs"],
      [4, "node:net"],
    ]);
  });

  it("invariant 3: no permission, even one a manifest should not have, lets a plugin refer to the frozen plan", () => {
    const text = 'readFile("plan.approved.yaml");';
    expect(checkPluginCode([file(text)], ["never" as never])).toEqual([
      { file: "dist/index.js", line: 1, use: "plan.approved.yaml", needs: "never" },
    ]);
  });
});
