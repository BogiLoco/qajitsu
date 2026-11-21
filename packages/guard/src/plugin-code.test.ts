import type { PluginPermission } from "@qajitsu/core";
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
      "/**",
      ' * process.env is documented here, as is require("node:fs")',
      " */",
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
    ["module", "exec"],
    ["vm", "exec"],
    ["inspector", "exec"],
    ["inspector/promises", "exec"],
    ["wasi", "exec"],
    ["repl", "exec"],
    ["v8", "exec"],
    ["sqlite", "filesystem"],
    ["process", "environment"],
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

  it("REQ-GEN-11/AC9: a type-only import or a comment hides nothing else on its line", () => {
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

  it("REQ-GEN-11/AC9: every form of loading a module counts; type positions and type-only forms do not", () => {
    const code = [
      'import fs = require("fs");',
      'import type T = require("net");',
      'export type { Socket } from "node:net";',
      'export { request } from "node:https";',
      'type S = typeof import("node:child_process");',
      "const m = await import(`node:dgram`);",
      "const dyn = require(name);",
      'import "node:cluster";',
      'load("child_process"); new Import("tls"); log(require);',
      'module.require("node:net"); require.main.require("tls"); (require)(("http"));',
      'require("child_process" + ""); import("./addon.node"); require("node:vm"); require("module");',
    ].join("\n");
    expect(checkPluginCode([file(code, "src/x.ts")], []).map((v) => [v.line, v.use])).toEqual([
      [1, "node:fs"],
      [4, "node:https"],
      [6, "node:dgram"],
      [8, "node:cluster"],
      [10, "node:net"],
      [10, "node:tls"],
      [10, "node:http"],
      [11, "node:child_process"],
      [11, "./addon.node"],
      [11, "node:vm"],
      [11, "node:module"],
    ]);
  });

  const uses = (code: string, permissions: PluginPermission[] = []) =>
    checkPluginCode([file(code)], permissions).map((v) => `${v.use} (${v.needs})`);

  it.each([
    // Reading the environment, however it is spelled.
    ["process.env.TOKEN", ["process.env (environment)"]],
    ['process["env"].TOKEN', ["process.env (environment)"]],
    ["process?.env", ["process.env (environment)"]],
    ["(process).env", ["process.env (environment)"]],
    ["globalThis.process.env", ["process.env (environment)"]],
    ['globalThis["process"].env', ["process.env (environment)"]],
    ["globalThis.self.process.env", ["process.env (environment)"]],
    ["const { env } = process;", ["process.env (environment)"]],
    ["const { env: e, cwd } = process;", ["process.env (environment)"]],
    ['const { ["env"]: e } = process;', ["process.env (environment)"]],
    // ... and through objects the check cannot follow: an alias, `this`, a function that returns the global object.
    [
      "const g = globalThis; g.process.env.TOKEN;",
      ["the global object passed on (exec)", "process.env (environment)"],
    ],
    ["(function () { return this; })().process.env.TOKEN", ["process.env (environment)"]],
    ['Function("return this")().process.env', ["process.env (environment)", "Function (exec)"]],
    ["this.process.getBuiltinModule('node:fs')", ["process.getBuiltinModule (exec)"]],
    // Properties of process that load code need exec; unknown ones too, only a short list is free.
    ['process.getBuiltinModule("node:child_process")', ["process.getBuiltinModule (exec)"]],
    [
      "process.binding('fs'); process.dlopen(m, f); process.mainModule.require",
      ["process.binding (exec)", "process.dlopen (exec)", "process.mainModule (exec)"],
    ],
    ["process.cwd(); process.platform; process.argv; process.nextTick(f); process.on('exit', f)", []],
    ["const { cwd, platform } = process;", []],
    [
      'if (typeof process !== "undefined" && typeof globalThis.fetch === "function") {}',
      ["global fetch (network)"],
    ],
    // Passed on, it could reach anything.
    ["const p = process;", ["process passed on (exec)"]],
    ["f(process);", ["process passed on (exec)"]],
    ["const all = { ...process };", ["process passed on (exec)"]],
    ["const k = process[key];", ["process passed on (exec)"]],
    ["const { ...rest } = process;", ["process passed on (exec)"]],
    ["let process = 1;", ["process passed on (exec)"]],
    // The global fetch, and the global object passed on.
    ["globalThis.fetch(url)", ["global fetch (network)"]],
    ['globalThis["fetch"]', ["global fetch (network)"]],
    ["const { fetch: f } = globalThis;", ["global fetch (network)"]],
    [
      "self.fetch; window.fetch; global.fetch",
      ["global fetch (network)", "global fetch (network)", "global fetch (network)"],
    ],
    ["globalThis.URL; globalThis.setTimeout(f)", []],
    ["const g = global;", ["the global object passed on (exec)"]],
    ['globalThis.eval("x"); eval("x"); new Function("x")', ["eval (exec)", "eval (exec)", "Function (exec)"]],
    // Names that only label something are not uses.
    ["const o = { process: 1, globalThis: 2, fetch() {} }; o.process.id; o.fetch;", []],
    ["const { env: x } = config; config.env; other['env'];", []],
    ["enum E { process } type P = typeof process.env;", []],
    [
      'const s = "code in a string, process.env and globalThis.fetch, is checked as the line-based check did";',
      ["process.env (environment)", "global fetch (network)"],
    ],
  ] as const)("REQ-GEN-11/AC4: %s", (code, expected) => {
    expect(uses(code)).toEqual(expected);
  });

  it.each([
    ["process.arch; process.argv; process.cwd(); process.emitWarning(w); process.exitCode = 1;"],
    [
      "process.hrtime(); process.nextTick(f); process.off(e, f); process.on(e, f); process.once(e, f); process.pid;",
    ],
    ["process.platform; process.release; process.stderr; process.stdout; process.uptime(); process.version;"],
    ["process.versions;"],
  ])("REQ-GEN-11/AC4: the harmless properties of process need nothing: %s", (code) => {
    expect(uses(code)).toEqual([]);
  });

  it.each([
    ["this.process.env", "process.env (environment)"],
    ["this.process.getBuiltinModule", "process.getBuiltinModule (exec)"],
    ["this.process.binding", "process.binding (exec)"],
    ["this.process._linkedBinding", "process._linkedBinding (exec)"],
    ["this.process.dlopen", "process.dlopen (exec)"],
    ["this.process.mainModule", "process.mainModule (exec)"],
    ['this["process"]["env"]', "process.env (environment)"],
    ["process.kill(1); process.stdin", "process.kill (exec)"],
  ])("REQ-GEN-11/AC4: %s is found on any object", (code, expected) => {
    expect(uses(code)[0]).toBe(expected);
  });

  it("REQ-GEN-11/AC4: process as a value or as a local name, and globals reached through globals, still count", () => {
    expect(uses("f({ p: process });")).toEqual(["process passed on (exec)"]);
    expect(uses("const { a: process } = obj;")).toEqual(["process passed on (exec)"]);
    expect(uses("globalThis.self.fetch(u);")).toEqual(["global fetch (network)"]);
    expect(uses("globalThis.process.kill(1);")).toEqual(["process.kill (exec)"]);
    expect(uses('global["process"].dlopen(m, f);')).toEqual(["process.dlopen (exec)"]);
  });

  it("REQ-GEN-11/AC4: other properties of a .process object are not uses; nor is an object's own process", () => {
    expect(uses("this.process.cwd(); config.process.name; obj.process.id;")).toEqual([]);
  });

  it("REQ-GEN-11/AC4: destructuring that is not a plain declaration of named keys counts as passing process on", () => {
    expect(uses("({ env } = process);")).toEqual(["process passed on (exec)"]);
    expect(uses("const { 0: x } = process;")).toEqual(["process passed on (exec)"]);
    expect(uses('const { "env": e } = process;')).toEqual(["process.env (environment)"]);
  });

  it("REQ-GEN-11/AC9: a module named like an object's own property is just a package", () => {
    expect(
      uses(
        'require("constructor"); require("toString"); require("__proto__"); require("node:hasOwnProperty");',
      ),
    ).toEqual([]);
  });

  it("REQ-GEN-11/AC9: every module a load could name counts, with its permission", () => {
    expect(
      checkPluginCode(
        [file('require("child_process" || x); import(c ? "fs" : "os"); require("./a.node");')],
        [],
      ).map((v) => `${v.use} (${v.needs})`),
    ).toEqual(["node:child_process (exec)", "node:fs (filesystem)", "./a.node (exec)"]);
    expect(uses('require("./native.nodes"); require("os" + suffix);')).toEqual([]);
  });

  it.each([
    ["x = 1 <!-- y", 1],
    ["const a = 1;\n-->", 2],
    ["  \t--> rest", 1],
    ["/* a */ --> rest", 1],
    ["/* abc */-->", 1],
    ["/**/ /* b */ --> rest", 1],
  ])("REQ-GEN-11/AC9: an HTML-like comment is refused: %j", (code, line) => {
    expect(checkPluginCode([file(code)], ["exec", "network", "filesystem", "environment"])).toEqual([
      { file: "dist/index.js", line, use: "an HTML-like comment", needs: "never" },
    ]);
  });

  it("REQ-GEN-11/AC9: --> in the middle of a line is an operator, not a comment", () => {
    expect(uses("let n = 3; while (n --> 0) {} const s = 'a --> b'; /* x --> y */")).toEqual([]);
  });

  it("invariant 3: a regular expression for the frozen plan is found, escaped or not", () => {
    expect(
      uses("/plan\\.approved\\.yaml$/.test(f); /plan.approved.yaml/.test(f); /plan\\.yaml/.test(f);"),
    ).toEqual(["plan.approved.yaml (never)", "plan.approved.yaml (never)"]);
  });

  it.each([
    // Code written into strings, read as the line-based check read every line.
    ["const s = 'x from\"node:dgram\"';", ["node:dgram (network)"]],
    ["const s = 'x from  \"node:dns\"';", ["node:dns (network)"]],
    ["const s = 'import(\"vm\")';", ["node:vm (exec)"]],
    ["const s = 'import  (  \"repl\")';", ["node:repl (exec)"]],
    ["const s = 'require(\"v8\")';", ["node:v8 (exec)"]],
    ["const s = 'require  (  \"wasi\")';", ["node:wasi (exec)"]],
    ["const s = 'require(`cluster`)';", ["node:cluster (exec)"]],
    ["const s = 'require(\"zod\")';", []],
    ['const s = "process.env";', ["process.env (environment)"]],
    ['const s = "process  .  env";', ["process.env (environment)"]],
    ['const s = "process.dlopen";', ["process in a string (exec)"]],
    ['const s = "process  .  binding";', ["process in a string (exec)"]],
    [
      'const s = "process.getBuiltinModule process._linkedBinding process.mainModule";',
      ["process in a string (exec)"],
    ],
    ['const s = "process.cwd()";', []],
    ['const s = "globalThis  .  fetch";', ["global fetch (network)"]],
    // Code from outside the plugin.
    ['require("data:text/javascript,1");', ["data:text/javascript,1 (exec)"]],
    ['require("file:///tmp/x.js");', ["file:///tmp/x.js (exec)"]],
    ['import("https://cdn.example.com/x.js");', ["https://cdn.example.com/x.js (exec)"]],
    ['require("/tmp/x.js");', ["/tmp/x.js (exec)"]],
    ['require("\\\\\\\\host\\\\share\\\\x.js");', ["\\\\host\\share\\x.js (exec)"]],
    ['require("node:fs");', ["node:fs (filesystem)"]],
    ['require("./lib/"); require("./a\\\\"); require("./a:b"); require("1:x");', []],
    // require through call and apply.
    ['require.call(null, "fs");', ["node:fs (filesystem)"]],
    ['require.apply(null, ["net"]);', ["node:net (network)"]],
    ['x.call(null, "fs"); require.bind(null);', []],
    // The Function constructor and Node's module loader.
    ['f.constructor("return 1")();', [".constructor (exec)"]],
    ["new this.constructor();", [".constructor (exec)"]],
    ['m._load("x");', ["._load (exec)"]],
    ['o.other("x"); o.constructor.name; o.constructor.prototype;', []],
    // eval and Function held rather than called.
    ["const F = Function;", ["Function passed on (exec)"]],
    ["[eval].map(f);", ["eval passed on (exec)"]],
    ["f(Function);", ["Function passed on (exec)"]],
    [
      "eval.call(null, code); Function.prototype.constructor;",
      ["eval passed on (exec)", ".constructor (exec)", "Function passed on (exec)"],
    ],
    ['new Function("x"); (Function)("x");', ["Function (exec)", "Function (exec)"]],
    ["o.Function; const k = { eval: 1 };", []],
    // process out of the global object, and an object's process.
    ["const { process: p } = globalThis;", ["process passed on (exec)"]],
    // The shorthand declares a local `process`, counted as passed on.
    ["const { fetch, process } = self;", ["process passed on (exec)", "global fetch (network)"]],
    ["globalThis.process.cwd();", []],
    // Final audit: Function and Module._load taken as values, process out of any object, data: modules held.
    ["const C = (() => {}).constructor;", [".constructor (exec)"]],
    ['[].map.constructor.call(null, "x");', [".constructor (exec)"]],
    ["const { constructor: C } = () => {};", [".constructor (exec)"]],
    ['const { ["_load"]: L } = module.constructor;', ["._load (exec)"]],
    ["const L = module.constructor._load;", ["._load (exec)"]],
    ["const { process: p } = g;", ["process passed on (exec)"]],
    ["const { process: { env } } = g;", ["process passed on (exec)"]],
    ['const u = "data:text/javascript,export default 1";', ["a data: module in a string (exec)"]],
    ['const u = " DATA:application/wasm;base64,AGFzbQ";', ["a data: module in a string (exec)"]],
    ['const img = "data:image/png;base64,iVBORw0";', []],
    [
      'x.constructor.apply(null, ["x"]); y.constructor.bind(null);',
      [".constructor (exec)", ".constructor (exec)"],
    ],
    ["const { call, name } = x.constructor;", [".constructor (exec)"]],
    ["const { name, prototype } = x.constructor;", []],
    ['const u = "data:  text/javascript,1";', ["a data: module in a string (exec)"]],
    ['const t = "see data:text/javascript in the docs";', []],
    ["const p = job.process;", ["process passed on (exec)"]],
    ["f(job.process);", ["process passed on (exec)"]],
    ["const { env } = job.process;", ["process.env (environment)"]],
    ["const { getBuiltinModule: g } = job.process;", ["process.getBuiltinModule (exec)"]],
    ["const { name } = job.process; job.process.name;", []],
  ] as const)("REQ-GEN-11/AC4+AC9: %s", (code, expected) => {
    expect(uses(code)).toEqual(expected);
  });

  it("REQ-GEN-11/AC4: each use is covered by its permission", () => {
    expect(
      uses("process.env.A; globalThis.fetch(u); process.getBuiltinModule('fs')", [
        "environment",
        "network",
        "exec",
      ]),
    ).toEqual([]);
    expect(uses("process.env.A", ["network"])).toEqual(["process.env (environment)"]);
  });

  it("invariant 3: the frozen plan is found in strings and every piece of a template literal", () => {
    const code = [
      "const a = `plan.approved.yaml`;",
      "const b = `${dir}/plan.approved.yaml`;",
      "const c = `${dir}plan.approved.yaml${x}`;",
      "const d = `${x}${dir}/plan.approved.yaml`;",
      "// plan.approved.yaml in a comment is not a use",
    ].join("\n");
    expect(checkPluginCode([file(code)], []).map((v) => v.line)).toEqual([1, 2, 3, 4]);
  });

  it("REQ-GEN-11/AC9: a file that does not parse is refused, since what it would do cannot be told", () => {
    expect(checkPluginCode([file('const ok = 1;\nconst = require("child_process");')], ["exec"])).toEqual([
      { file: "dist/index.js", line: 2, use: "code that does not parse", needs: "never" },
    ]);
  });

  it.each(["a.ts", "a.mts", "a.cts", "a.d.ts", "a.tsx", "a.jsx", "a.js", "a.mjs", "a.cjs"])(
    "REQ-GEN-11/AC9: %s is parsed as what it is",
    (path) => {
      const jsx = path.endsWith("x") ? "const v = <div>{1}</div>;\n" : "";
      const typed = path.endsWith("ts") ? "const n: number = 1;\n" : "";
      const code = `${jsx}${typed}const c = require("child_process");`;
      expect(checkPluginCode([file(code, path)], []).map((v) => v.use)).toEqual(["node:child_process"]);
    },
  );
});
