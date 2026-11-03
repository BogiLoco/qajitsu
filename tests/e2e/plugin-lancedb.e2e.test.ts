import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { VectorStore } from "@qajitsu/core";
import { afterAll, describe, expect, it } from "vitest";
import { runTool } from "../../packages/cli/src/commands/setup.js";
import { readCatalogue } from "../../packages/cli/src/plugins/catalogue.js";
import { installPlugin } from "../../packages/cli/src/plugins/install.js";
import { HOST_PACKAGES, bundledPackageDir, createPluginLoader } from "../../packages/cli/src/plugins/load.js";
import { vectorStoreContract } from "../contract/vector-store.contract.js";

// REQ-GEN-11/AC11: the LanceDB plugin, packed as it is published and installed the way `qj plugin add --file` does,
// passes the VectorStore contract as installed, against this installation's core. npm downloads LanceDB from the
// public registry (about 250 MB), so this suite runs only with QAJITSU_E2E_NETWORK=1.
const PKG = "@qajitsu/adapter-knowledge-lancedb";
const network = process.env["QAJITSU_E2E_NETWORK"] === "1";
const repo = resolve(fileURLToPath(import.meta.url), "../../..");

let work: string | undefined;
let loading: Promise<{ createLanceDbStore(dir: string): Promise<VectorStore> }> | undefined;

/** Packs, installs and loads the plugin once for the whole suite. */
function plugin(): Promise<{ createLanceDbStore(dir: string): Promise<VectorStore> }> {
  loading ??= (async () => {
    work = await mkdtemp(join(tmpdir(), "qj-lancedb-plugin-"));
    execFileSync("pnpm", ["pack", "--pack-destination", work], {
      cwd: join(repo, "packages", "adapters", "knowledge-lancedb"),
      stdio: "pipe",
    });
    const tarball = join(work, (await readdir(work)).find((f) => f.endsWith(".tgz")) ?? "");
    const root = join(work, "plugins");
    const record = await installPlugin({
      root,
      id: "knowledge-lancedb",
      source: { kind: "file", path: tarball },
      expectedPackage: PKG,
      hostPackages: HOST_PACKAGES,
      ports: {
        fetch: globalThis.fetch,
        run: runTool,
        now: () => new Date(),
        registry: "https://registry.npmjs.org",
      },
    });
    // The omitted embedding helpers are empty packages; the plugin has no own core.
    expect(existsSync(join(record.path, "node_modules", "onnxruntime-node"))).toBe(false);
    expect(existsSync(join(record.path, "node_modules", "@qajitsu", "core"))).toBe(false);
    const loader = createPluginLoader({
      root,
      catalogue: readCatalogue(),
      // This checkout carries LanceDB as a dev dependency of the CLI; the installed copy is the one under test.
      bundled: (name) => (name === PKG ? undefined : bundledPackageDir(name)),
    });
    const mod = await loader.load<{ createLanceDbStore(dir: string): Promise<VectorStore> }>(
      "knowledge-lancedb",
    );
    expect(loader.used()[0]).toMatchObject({ id: "knowledge-lancedb", source: "installed" });
    return mod;
  })();
  return loading;
}

afterAll(async () => {
  if (work !== undefined) await rm(work, { recursive: true, force: true });
});

describe.skipIf(!network)("LanceDB as an installed plugin (REQ-GEN-11/AC11)", () => {
  it("REQ-GEN-11/AC11: installs from its tarball and loads against this installation's core", async () => {
    expect(typeof (await plugin()).createLanceDbStore).toBe("function");
  });

  vectorStoreContract("lancedb (installed plugin)", async (key) =>
    (await plugin()).createLanceDbStore(join(work ?? tmpdir(), "stores", key)),
  );
});
