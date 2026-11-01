import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@qajitsu/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTool } from "../../packages/cli/src/commands/setup.js";
import { installPlugin } from "../../packages/cli/src/plugins/install.js";
import { HOST_PACKAGES, bundledPackageDir, createPluginLoader } from "../../packages/cli/src/plugins/load.js";

// REQ-GEN-11 end to end with the real npm and Node's module resolution: a plugin packed into a tarball is installed
// offline without its install script, and once loaded it runs against this installation's @qajitsu/core.
const PKG = "@qajitsu/adapter-fixture-store";
let work: string;
let tarball: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "qj-plugin-e2e-"));
  const src = join(work, "src");
  await mkdir(join(src, "dist"), { recursive: true });
  await writeFile(
    join(src, "package.json"),
    JSON.stringify({
      name: PKG,
      version: "1.0.0",
      type: "module",
      exports: { ".": { import: "./dist/index.js" } },
      files: ["dist"],
      // A plugin that tries to run code at install time; npm runs with --ignore-scripts.
      scripts: {
        postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(join(work, "POSTINSTALL_RAN"))},'')"`,
      },
      peerDependencies: { "@qajitsu/core": "*" },
      qajitsu: { plugin: { types: ["knowledge store"], core_api: "^1.0.0", permissions: ["filesystem"] } },
    }),
  );
  await writeFile(
    join(src, "dist", "index.js"),
    'import { PLUGIN_API_VERSION, PluginError } from "@qajitsu/core";\nexport const api = PLUGIN_API_VERSION;\nexport const errorClass = PluginError;\n',
  );
  execFileSync("npm", ["pack", "--pack-destination", work, "--ignore-scripts"], { cwd: src, stdio: "pipe" });
  tarball = join(work, (await readdir(work)).find((f) => f.endsWith(".tgz")) ?? "");
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("plugins installed with npm (REQ-GEN-11)", () => {
  it("REQ-GEN-11/AC3: installs a tarball offline without running its install script, then loads it against the installation's core", async () => {
    const root = join(work, "home", "plugins");
    const record = await installPlugin({
      root,
      id: "fixture-store",
      source: { kind: "file", path: tarball },
      expectedPackage: PKG,
      hostPackages: HOST_PACKAGES,
      ports: {
        fetch: () => Promise.reject(new Error("no network in this test")),
        run: runTool,
        now: () => new Date("2026-11-01T10:00:00Z"),
        registry: "http://127.0.0.1:9",
        env: { npm_config_offline: "true", npm_config_cache: join(work, "npm-cache") },
      },
    });
    expect(record).toMatchObject({ id: "fixture-store", version: "1.0.0", source: "file" });
    expect(
      existsSync(join(record.path, "node_modules", "@qajitsu", "adapter-fixture-store", "dist", "index.js")),
    ).toBe(true);
    // Invariant: plugins are installed without install scripts.
    expect(existsSync(join(work, "POSTINSTALL_RAN"))).toBe(false);
    expect(existsSync(join(record.path, "node_modules", "@qajitsu", "core"))).toBe(false);

    const loader = createPluginLoader({
      root,
      catalogue: { schema: 1, plugins: { "fixture-store": { package: PKG, version: "1.0.0" } } },
      bundled: (name) => (name === PKG ? undefined : bundledPackageDir(name)),
    });
    const mod = await loader.load<{ api: string; errorClass: unknown }>("fixture-store");
    expect(mod.api).toBe(PLUGIN_API_VERSION);
    expect(existsSync(join(root, "node_modules", "@qajitsu", "core", "package.json"))).toBe(true);
    expect(loader.used()).toEqual([
      { id: "fixture-store", package: PKG, version: "1.0.0", source: "installed" },
    ]);
  });
});
