import { existsSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PLUGIN_API_VERSION, PluginError, parsePluginManifest, type PluginManifest } from "@qajitsu/core";
import { satisfies } from "@qajitsu/toolchain";
import { catalogueEntry, installCommand, type PluginCatalogue } from "./catalogue.js";
import { assertPluginCode } from "./code.js";
import { readInstalledPlugins } from "./store.js";

/** QAJitsu's own packages: always the installation's copies, never a plugin's (REQ-GEN-11/AC4). */
export const HOST_PACKAGES = [
  "@qajitsu/core",
  "@qajitsu/steps",
  "@qajitsu/guard",
  "@qajitsu/verifier",
  "@qajitsu/models",
  "@qajitsu/report",
  "@qajitsu/toolchain",
  "@qajitsu/agents",
] as const;

/** Where a plugin was found: still part of this installation, or installed into the QAJitsu home. */
export interface PluginAvailability {
  readonly id: string;
  readonly package: string;
  readonly version: string;
  readonly source: "bundled" | "installed";
}

/** Loads plugins by id and remembers which ones a command used (REQ-GEN-11/AC2, AC5). */
export interface PluginLoader {
  /** Where the plugin is, or undefined when it is missing. */
  availability(id: string): Promise<PluginAvailability | undefined>;
  /**
   * Imports the plugin's module.
   *
   * @throws {PluginError} `PLUGIN_MISSING` with the install command, `PLUGIN_INCOMPATIBLE` or
   *   `PLUGIN_MANIFEST_INVALID`.
   */
  load<T>(id: string): Promise<T>;
  /** The plugins loaded so far, in order. */
  used(): readonly PluginAvailability[];
  /**
   * The manifest of a plugin that is there (REQ-GEN-11/AC7), for the hosts its network guard allows.
   *
   * @throws {PluginError} `PLUGIN_MISSING` or `PLUGIN_MANIFEST_INVALID`.
   */
  manifest(id: string): Promise<PluginManifest>;
}

/**
 * The folder of a package this installation carries, or undefined when it does not (REQ-GEN-11, ADR-0015). Only the
 * CLI's own tree counts: its own `node_modules`, then the `node_modules` folder the CLI sits in (npm and pnpm put its
 * dependencies there). Folders above it (a project's, the home folder's, `NODE_PATH`, global folders) never do: anyone
 * could put a package there, and a bundled plugin skips the checks an installed one gets. The first folder found is
 * the package, as for Node; its own `package.json` decides, so a package is found whether or not it was built (CI
 * tests before the build), and a linked package resolves to its real folder.
 *
 * @param name - The package name, e.g. `@qajitsu/adapter-knowledge-lancedb`.
 * @param from - Where the lookup starts (this module; replaced in tests).
 */
export function bundledPackageDir(name: string, from: string = import.meta.url): string | undefined {
  const root = cliRoot(dirname(fileURLToPath(from)));
  if (root === undefined) return undefined;
  const folders = [join(root, "node_modules")];
  for (let dir = dirname(root); dirname(dir) !== dir; dir = dirname(dir))
    if (basename(dir) === "node_modules") {
      folders.push(dir);
      break;
    }
  for (const folder of folders) {
    const candidate = join(folder, ...name.split("/"));
    if (!existsSync(candidate)) continue;
    let manifest: { name?: unknown } | undefined;
    try {
      manifest = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as { name?: unknown };
    } catch {
      manifest = undefined;
    }
    // Node stops at this folder: one without the package's own manifest is not this package.
    return manifest?.name === name ? realpathSync(candidate) : undefined;
  }
  return undefined;
}

/** The folder of the `@qajitsu/cli` package the module belongs to, or undefined outside one. */
function cliRoot(start: string): string | undefined {
  for (let dir = start; ; dir = dirname(dir)) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown };
      if (manifest.name === "@qajitsu/cli") return dir;
    } catch {
      // No manifest here; look further up.
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** The ESM entry of an installed package (`exports["."].import`, `exports["."]` or `main`). */
function entryOf(pkgDir: string): string {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
    exports?: unknown;
    main?: string;
  };
  const dot: unknown =
    pkg.exports !== null && typeof pkg.exports === "object"
      ? (pkg.exports as Record<string, unknown>)["."]
      : pkg.exports;
  const entry =
    typeof dot === "string"
      ? dot
      : dot !== null && typeof dot === "object"
        ? ((dot as Record<string, unknown>)["import"] ?? (dot as Record<string, unknown>)["default"])
        : undefined;
  return join(pkgDir, typeof entry === "string" ? entry : (pkg.main ?? "index.js"));
}

/**
 * Links QAJitsu's own packages into `<root>/node_modules`, where Node resolves them from every installed plugin, so a
 * plugin uses the installation's core, steps and guard (REQ-GEN-11/AC4).
 */
export async function linkHostPackages(root: string, dirs: Readonly<Record<string, string>>): Promise<void> {
  for (const [name, dir] of Object.entries(dirs)) {
    const link = join(root, "node_modules", ...name.split("/"));
    const current = await lstat(link).catch(() => undefined);
    if (current?.isSymbolicLink() && (await readlink(link)) === dir) continue;
    await rm(link, { recursive: true, force: true });
    await mkdir(dirname(link), { recursive: true });
    await symlink(dir, link, "dir");
  }
}

/**
 * Creates the plugin loader of a command (REQ-GEN-11/AC2): a plugin still carried by this installation is imported
 * as it is; otherwise the one installed into the plugins folder, after its manifest and core API range are checked
 * (AC7, AC8); a missing plugin stops the command with the command that installs it, never with a module error.
 *
 * @param options - The plugins folder, the catalogue, and the seams tests replace.
 */
export function createPluginLoader(options: {
  readonly root: string;
  readonly catalogue: PluginCatalogue;
  readonly bundled?: (name: string) => string | undefined;
  readonly importModule?: (specifier: string) => Promise<unknown>;
  readonly hostDirs?: () => Readonly<Record<string, string>>;
}): PluginLoader {
  const bundled = options.bundled ?? bundledPackageDir;
  const importModule = options.importModule ?? ((s: string) => import(s) as Promise<unknown>);
  const hostDirs =
    options.hostDirs ??
    (() =>
      Object.fromEntries(
        HOST_PACKAGES.flatMap((n) => {
          const dir = bundled(n);
          return dir === undefined ? [] : [[n, dir] as const];
        }),
      ));
  const used: PluginAvailability[] = [];

  /** The package folder of an installed plugin, by package name. */
  const installedDir = async (name: string): Promise<string | undefined> => {
    const record = (await readInstalledPlugins(options.root)).find((p) => p.package === name);
    const dir = record ? join(record.path, "node_modules", ...name.split("/")) : undefined;
    return dir !== undefined && existsSync(dir) ? dir : undefined;
  };

  const availability = async (id: string): Promise<PluginAvailability | undefined> => {
    const entry = catalogueEntry(options.catalogue, id);
    const dir = bundled(entry.package);
    if (dir !== undefined) {
      const version = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string })
        .version;
      return { id: entry.id, package: entry.package, version: version ?? entry.version, source: "bundled" };
    }
    const installed = (await readInstalledPlugins(options.root)).find((p) => p.id === entry.id);
    if (!installed || !existsSync(installed.path)) return undefined;
    return { id: entry.id, package: installed.package, version: installed.version, source: "installed" };
  };

  /** The package folder of a plugin that is there, bundled or installed. */
  const packageDir = async (found: PluginAvailability): Promise<string> =>
    found.source === "bundled"
      ? (bundled(found.package) ?? "")
      : join(
          (await readInstalledPlugins(options.root)).find((p) => p.id === found.id)?.path ?? "",
          "node_modules",
          ...found.package.split("/"),
        );

  return {
    availability,
    used: () => [...used],
    manifest: async (id) => {
      const found = await availability(id);
      if (found === undefined)
        throw new PluginError(
          "PLUGIN_MISSING",
          `The ${id} plugin is not installed. Install it with: ${installCommand(id)}`,
          {
            plugin: id,
          },
        );
      return parsePluginManifest(
        JSON.parse(readFileSync(join(await packageDir(found), "package.json"), "utf8")) as unknown,
      );
    },
    load: async <T>(id: string): Promise<T> => {
      const found = await availability(id);
      if (found === undefined) {
        const entry = catalogueEntry(options.catalogue, id);
        throw new PluginError(
          "PLUGIN_MISSING",
          `The ${entry.id} plugin is not installed. Install it with: ${installCommand(entry.id)}`,
          { plugin: entry.id },
        );
      }
      let module: unknown;
      if (found.source === "bundled") module = await importModule(found.package);
      else {
        const installed = (await readInstalledPlugins(options.root)).find((p) => p.id === found.id);
        const pkgDir = join(installed?.path ?? "", "node_modules", ...found.package.split("/"));
        const manifest = parsePluginManifest(
          JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as unknown,
        );
        if (!satisfies(PLUGIN_API_VERSION, manifest.coreApi))
          throw new PluginError(
            "PLUGIN_INCOMPATIBLE",
            `${manifest.name}@${manifest.version} works with core API ${manifest.coreApi}; this QAJitsu has ${PLUGIN_API_VERSION}. Install the version of this release: ${installCommand(found.id)}`,
            { plugin: found.id, coreApi: manifest.coreApi, have: PLUGIN_API_VERSION },
          );
        // REQ-GEN-11/AC9: a plugin changed on disk since its install is checked again before it runs.
        await assertPluginCode(found.id, pkgDir, manifest);
        // The plugins it needs are linked next to QAJitsu's own packages, from this installation or its plugins.
        const required: Record<string, string> = {};
        for (const name of installed?.requires ?? []) {
          const dir = bundled(name) ?? (await installedDir(name));
          if (dir === undefined) {
            const need = catalogueEntry(options.catalogue, name).id;
            throw new PluginError(
              "PLUGIN_MISSING",
              `The ${found.id} plugin needs the ${need} plugin. Install it with: ${installCommand(need)}`,
              { plugin: need, requiredBy: found.id },
            );
          }
          required[name] = dir;
        }
        await linkHostPackages(options.root, { ...hostDirs(), ...required });
        module = await importModule(pathToFileURL(entryOf(pkgDir)).href);
      }
      if (!used.some((u) => u.id === found.id)) used.push(found);
      return module as T;
    },
  };
}
