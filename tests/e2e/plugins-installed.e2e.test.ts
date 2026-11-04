import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runTool } from "../../packages/cli/src/commands/setup.js";
import { readCatalogue } from "../../packages/cli/src/plugins/catalogue.js";
import { installPlugin } from "../../packages/cli/src/plugins/install.js";
import { HOST_PACKAGES, bundledPackageDir, createPluginLoader } from "../../packages/cli/src/plugins/load.js";
import { pluginContracts } from "./plugin-contracts.js";

// REQ-GEN-11/AC11: every plugin that moved out of the CLI is packed as it is published, installed the way
// `qj plugin add --file` does (real npm, the public registry for its third-party dependencies) and passes its contract
// tests as installed, against this installation's core. Downloads make this suite opt-in: QAJITSU_E2E_NETWORK=1.
const network = process.env["QAJITSU_E2E_NETWORK"] === "1";
const repo = resolve(fileURLToPath(import.meta.url), "../../..");
const catalogue = readCatalogue();
let work: string | undefined;
const loads = new Map<string, Promise<unknown>>();

/** Packs, installs and loads one plugin once for the whole suite. */
function installed<T>(id: string): Promise<T> {
  let loading = loads.get(id);
  if (!loading) {
    loading = (async () => {
      work ??= await mkdtemp(join(tmpdir(), "qj-plugins-installed-"));
      const pkg = catalogue.plugins[id]?.package ?? "";
      const dest = join(work, "tgz", id);
      execFileSync("pnpm", ["pack", "--pack-destination", dest], {
        cwd: join(repo, "packages", "adapters", id),
        stdio: "pipe",
      });
      const tarball = join(dest, (await readdir(dest)).find((f) => f.endsWith(".tgz")) ?? "");
      const root = join(work, "plugins");
      const record = await installPlugin({
        root,
        id,
        source: { kind: "file", path: tarball },
        expectedPackage: pkg,
        hostPackages: HOST_PACKAGES,
        ports: {
          fetch: globalThis.fetch,
          run: runTool,
          now: () => new Date(),
          registry: "https://registry.npmjs.org",
        },
      });
      expect(existsSync(join(record.path, "node_modules", "@qajitsu", "core"))).toBe(false);
      // This checkout carries the plugins as dev dependencies of the CLI; the installed copy is the one under test.
      const loader = createPluginLoader({
        root,
        catalogue,
        bundled: (name) => (name === pkg ? undefined : bundledPackageDir(name)),
      });
      const mod = await loader.load(id);
      expect(loader.used()[0]).toMatchObject({ id, source: "installed" });
      return mod;
    })();
    loads.set(id, loading);
  }
  return loading as Promise<T>;
}

/** A scratch folder for the plugins' own files. */
const scratch = (key: string): string => join(work ?? tmpdir(), "data", key);

afterAll(async () => {
  if (work !== undefined) await rm(work, { recursive: true, force: true });
});

describe.skipIf(!network)("plugins as installed (REQ-GEN-11/AC11)", () => {
  for (const contract of pluginContracts) {
    it(`REQ-GEN-11/AC11: ${contract.id} installs from its tarball and loads against this installation's core`, async () => {
      expect(await installed(contract.id)).toBeTypeOf("object");
    });
    contract.run((name) => installed(name), scratch);
  }
});
