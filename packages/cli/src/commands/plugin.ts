import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  PLUGIN_API_VERSION,
  QajitsuError,
  listProjects,
  parsePluginManifest,
  parseOnlineLocator,
  projectPaths,
  qajitsuHome,
  readKnowledgeSources,
  type ResolvedProject,
} from "@qajitsu/core";
import { loadToolchainConfig, networkFor, satisfies } from "@qajitsu/toolchain";
import type { RuntimePorts } from "../adapters.js";
import type { DoctorCheck } from "../doctor.js";
import { catalogueEntry, installCommand, readCatalogue, type PluginCatalogue } from "../plugins/catalogue.js";
import { installPlugin, removePlugin, type PluginInstallPorts } from "../plugins/install.js";
import {
  HOST_PACKAGES,
  createPluginLoader,
  type PluginAvailability,
  type PluginLoader,
} from "../plugins/load.js";
import { guardedFetch } from "../plugins/network.js";
import { pluginNeeds, type PluginNeed } from "../plugins/needs.js";
import {
  appendPluginHistory,
  pluginsRoot,
  readInstalledPlugins,
  writeInstalledPlugins,
  type InstalledPlugin,
} from "../plugins/store.js";
import { loadProject, type LoadedProject } from "../project.js";
import type { CommandIO } from "./fetch.js";
import { runTool } from "./setup.js";

const PUBLIC_REGISTRY = "https://registry.npmjs.org";
const loaders = new Map<string, PluginLoader>();

/** The plugins folder and the catalogue of this installation. */
function pluginHome(ports: RuntimePorts): { root: string; catalogue: PluginCatalogue } {
  return {
    root: pluginsRoot(qajitsuHome(ports.env, ports.home)),
    catalogue: ports.pluginCatalogue ?? readCatalogue(),
  };
}

/**
 * The plugin loader of this process (REQ-GEN-11/AC2): one per plugins folder, so the plugins a command used can be
 * recorded with its run (AC5).
 */
export function pluginLoader(ports: RuntimePorts): PluginLoader {
  if (ports.plugins) return ports.plugins;
  const { root, catalogue } = pluginHome(ports);
  let loader = loaders.get(root);
  if (!loader) {
    loader = createPluginLoader({ root, catalogue });
    loaders.set(root, loader);
  }
  return loader;
}

/**
 * The plugin loader of a run session (REQ-GEN-11/AC2); a session built by hand (tests) loads the plugins this
 * installation carries.
 */
export function sessionPlugins(session: { readonly plugins?: PluginLoader | undefined }): PluginLoader {
  return session.plugins ?? createPluginLoader({ root: "", catalogue: readCatalogue() });
}

/**
 * A plugin when it is there, else undefined (REQ-GEN-11/AC2): for work that has nothing to do without it, such as
 * removing the containers of a run when the compose plugin, which alone starts them, is not installed.
 */
export async function optionalPlugin<T>(loader: PluginLoader, id: string): Promise<T | undefined> {
  return (await loader.availability(id)) === undefined ? undefined : loader.load<T>(id);
}

/**
 * The `fetch` of an integration plugin (REQ-GEN-11/AC9, ADR-0015): only to the hosts of its manifest and, for
 * `config`, the URLs the project configures for it; read from the manifest on the first request.
 *
 * @param loader - The plugin loader.
 * @param fetchImpl - The process's fetch.
 * @param id - The plugin.
 * @param configured - URLs the project configures for this plugin.
 */
export function pluginFetch(
  loader: PluginLoader,
  fetchImpl: typeof globalThis.fetch,
  id: string,
  configured: readonly (string | undefined)[],
  configuredHosts: readonly string[] = [],
): typeof globalThis.fetch {
  let guarded: Promise<typeof globalThis.fetch> | undefined;
  return async (input, init) => {
    guarded ??= loader
      .manifest(id)
      .then((m) => guardedFetch(fetchImpl, { plugin: id, hosts: m.hosts, configured, configuredHosts }));
    return (await guarded)(input, init);
  };
}

/** The hosts Jira's attachments redirect to (`publish.media_hosts`), each with its subdomains. */
export function jiraMediaHosts(config: LoadedProject["config"]): string[] {
  return config.publish.media_hosts.flatMap((h) => [h, `*.${h}`]);
}

/** Installing from the npm registry the toolchain uses (a company mirror, a proxy, a CA), npm without a shell. */
async function installPorts(
  ports: RuntimePorts,
  project: LoadedProject | undefined,
): Promise<PluginInstallPorts> {
  const config = await loadToolchainConfig(qajitsuHome(ports.env, ports.home), project?.qaDir);
  return {
    fetch: ports.fetch,
    run: ports.toolchain?.run ?? runTool,
    now: ports.now,
    registry: config.sources.npm_registry ?? PUBLIC_REGISTRY,
    env: networkFor(config).env,
  };
}

/** Whether the project has a knowledge base on disk (the store is needed only then), and its online sources. */
async function knowledgeOf(
  project: LoadedProject,
): Promise<{ readonly knowledge: boolean; readonly onlineSources: readonly string[] }> {
  const dir = project.project?.paths.knowledge;
  if (dir === undefined || !existsSync(dir)) return { knowledge: false, onlineSources: [] };
  // `qj init` creates the folder: a knowledge base is one with sources, or one that was indexed. A sources file that
  // cannot be read still counts, so the store it needs is not hidden behind the broken file.
  const sources = await readKnowledgeSources(dir).catch(() => undefined);
  return {
    knowledge: sources === undefined || sources.length > 0 || existsSync(join(dir, "index.json")),
    onlineSources: (sources ?? []).map((s) => s.path).filter((p) => parseOnlineLocator(p) !== undefined),
  };
}

/** A needed plugin with where it is, or undefined when it is missing. */
export interface PluginState extends PluginNeed {
  readonly found: PluginAvailability | undefined;
}

/** The plugins a project needs and whether each one is there (REQ-GEN-11/AC2). */
export async function projectPlugins(project: LoadedProject, ports: RuntimePorts): Promise<PluginState[]> {
  const loader = pluginLoader(ports);
  const out: PluginState[] = [];
  for (const need of pluginNeeds(project.config, await knowledgeOf(project)))
    out.push({ ...need, found: await loader.availability(need.id) });
  return out;
}

/**
 * The doctor check of plugins (REQ-GEN-11/AC2): every plugin the project's settings need and lack, with the setting
 * and the command that installs it.
 */
export async function pluginCheck(project: LoadedProject, ports: RuntimePorts): Promise<DoctorCheck> {
  const states = await projectPlugins(project, ports);
  const missing = states.filter((s) => s.found === undefined);
  const ids = [...new Set(states.map((s) => s.id))];
  if (missing.length === 0)
    return { name: "plugins", ok: true, detail: `${String(ids.length)} needed, all available` };
  return {
    name: "plugins",
    ok: false,
    detail: missing.map((m) => `${m.id} missing (${m.setting}): ${installCommand(m.id)}`).join("; "),
  };
}

/**
 * The plugin versions a run uses (REQ-GEN-11/AC5), for `run.json` next to the tool versions (REQ-OBS-10): every
 * plugin the project needs with its version and whether it came with the installation or was installed.
 */
export async function pluginVersions(
  project: LoadedProject,
  ports: RuntimePorts,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const s of await projectPlugins(project, ports))
    out[`plugin ${s.id}`] = s.found ? `${s.found.version} (${s.found.source})` : "missing";
  return out;
}

/**
 * Installs the plugins a project needs and lacks (`qj setup`, `qj doctor --fix`; REQ-GEN-11/AC3).
 *
 * @returns The ids installed and the failures, each with its reason.
 */
export async function installMissingPlugins(
  project: LoadedProject,
  ports: RuntimePorts,
  log: (line: string) => void,
): Promise<{ readonly installed: string[]; readonly failed: string[] }> {
  const missing = [
    ...new Set((await projectPlugins(project, ports)).filter((s) => !s.found).map((s) => s.id)),
  ];
  const installed: string[] = [];
  const failed: string[] = [];
  if (missing.length === 0) return { installed, failed };
  const { root, catalogue } = pluginHome(ports);
  const iports = await installPorts(ports, project);
  for (const id of missing) {
    const entry = catalogueEntry(catalogue, id);
    log(`plugin ${id}: installing ${entry.package}@${entry.version}`);
    try {
      const record = await installPlugin({
        root,
        id,
        source: { kind: "registry", package: entry.package, version: entry.version },
        expectedPackage: entry.package,
        hostPackages: HOST_PACKAGES,
        ports: iports,
      });
      installed.push(id, ...(await installRequirements(record, { root, catalogue, ports, iports, log })));
    } catch (error) {
      failed.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { installed, failed };
}

/**
 * Installs the plugins an installed plugin needs and lacks (its `@qajitsu/adapter-*` peers), at the versions this
 * release pins, and theirs in turn; each is logged.
 */
async function installRequirements(
  record: InstalledPlugin,
  context: {
    readonly root: string;
    readonly catalogue: PluginCatalogue;
    readonly ports: RuntimePorts;
    readonly iports: PluginInstallPorts;
    readonly log: (line: string) => void;
    /** Whether a plugin is already there; by default in this installation. */
    readonly available?: (id: string) => Promise<boolean>;
  },
  seen = new Set<string>([record.id]),
): Promise<string[]> {
  const installed: string[] = [];
  const available =
    context.available ??
    (async (id: string) => (await pluginLoader(context.ports).availability(id)) !== undefined);
  for (const name of record.requires) {
    const entry = catalogueEntry(context.catalogue, name);
    if (seen.has(entry.id) || (await available(entry.id))) continue;
    seen.add(entry.id);
    context.log(`plugin ${entry.id}: installing ${entry.package}@${entry.version}, needed by ${record.id}`);
    const required = await installPlugin({
      root: context.root,
      id: entry.id,
      source: { kind: "registry", package: entry.package, version: entry.version },
      expectedPackage: entry.package,
      hostPackages: HOST_PACKAGES,
      ports: context.iports,
    });
    installed.push(entry.id, ...(await installRequirements(required, context, seen)));
  }
  return installed;
}

/**
 * Puts the plugins a project needs, installed with their dependencies, into an offline bundle (`qj setup --download`,
 * REQ-GEN-11/AC6): each is checked against its published checksum like `qj plugin add`; plugins this installation
 * carries are left out.
 *
 * @returns The ids put into the bundle and the failures with their reasons.
 */
export async function bundlePlugins(
  project: LoadedProject,
  ports: RuntimePorts,
  bundleDir: string,
  log: (line: string) => void,
): Promise<{ readonly bundled: string[]; readonly failed: string[] }> {
  const root = join(bundleDir, "plugins");
  const { catalogue } = pluginHome(ports);
  const loader = pluginLoader(ports);
  const iports = await installPorts(ports, project);
  const inBundle = async (id: string): Promise<boolean> =>
    (await loader.availability(id))?.source === "bundled" ||
    (await readInstalledPlugins(root)).some((p) => p.id === id);
  const bundled: string[] = [];
  const failed: string[] = [];
  for (const id of [...new Set((await projectPlugins(project, ports)).map((s) => s.id))]) {
    if (await inBundle(id)) continue;
    const entry = catalogueEntry(catalogue, id);
    log(`plugin ${id}: into the bundle, ${entry.package}@${entry.version}`);
    try {
      const record = await installPlugin({
        root,
        id,
        source: { kind: "registry", package: entry.package, version: entry.version },
        expectedPackage: entry.package,
        hostPackages: HOST_PACKAGES,
        ports: iports,
      });
      bundled.push(
        id,
        ...(await installRequirements(record, { root, catalogue, ports, iports, log, available: inBundle })),
      );
    } catch (error) {
      failed.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { bundled, failed };
}

/**
 * Installs the plugins of an offline bundle (`qj setup --from`, REQ-GEN-11/AC6) without any network: each plugin's
 * folder is copied into this installation after its manifest and core API range are checked again, and recorded with
 * the checksum it was downloaded with.
 *
 * @returns The ids installed and the failures with their reasons.
 */
export async function importPluginBundle(
  bundleDir: string,
  ports: RuntimePorts,
  log: (line: string) => void,
): Promise<{ readonly installed: string[]; readonly failed: string[] }> {
  const from = join(bundleDir, "plugins");
  const { root } = pluginHome(ports);
  const installed: string[] = [];
  const failed: string[] = [];
  for (const record of await readInstalledPlugins(from)) {
    try {
      const source = join(from, record.id, record.version);
      const manifest = parsePluginManifest(
        JSON.parse(
          await readFile(join(source, "node_modules", ...record.package.split("/"), "package.json"), "utf8"),
        ) as unknown,
      );
      if (manifest.name !== record.package || !satisfies(PLUGIN_API_VERSION, manifest.coreApi))
        throw new QajitsuError(
          "PLUGIN_INCOMPATIBLE",
          `${manifest.name}@${manifest.version} does not fit this QAJitsu (core API ${PLUGIN_API_VERSION}).`,
          { plugin: record.id },
        );
      const target = join(root, record.id, record.version);
      await rm(join(root, record.id), { recursive: true, force: true });
      await mkdir(join(root, record.id), { recursive: true });
      await cp(source, target, { recursive: true, verbatimSymlinks: true });
      const now = ports.now().toISOString();
      const others = (await readInstalledPlugins(root)).filter((p) => p.id !== record.id);
      await writeInstalledPlugins(root, [
        ...others,
        { ...record, path: target, installed_at: now, from: `offline bundle ${bundleDir}` },
      ]);
      await appendPluginHistory(root, {
        at: now,
        action: "add",
        id: record.id,
        version: record.version,
        source: `offline bundle ${bundleDir}`,
        integrity: record.integrity,
      });
      log(`✔ plugin ${record.id} ${record.version} installed from the bundle`);
      installed.push(record.id);
    } catch (error) {
      failed.push(`${record.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { installed, failed };
}

/** Projects and settings that use a plugin, across every registered project (REQ-GEN-11/AC10). */
async function usersOf(id: string, ports: RuntimePorts, cwd: string): Promise<string[]> {
  const home = qajitsuHome(ports.env, ports.home);
  const users: string[] = [];
  for (const record of await listProjects(home)) {
    const resolved: ResolvedProject = {
      slug: record.slug,
      record,
      paths: projectPaths(home, record.slug),
      via: "flag",
    };
    const project = await loadProject(cwd, resolved, ports.env).catch(() => undefined);
    if (!project) continue;
    for (const need of pluginNeeds(project.config, await knowledgeOf(project)))
      if (need.id === id) users.push(`${record.slug}: ${need.setting}`);
  }
  return users;
}

const fail = (io: CommandIO, error: unknown): number => {
  const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
  io.writeError(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`);
  return 3;
};

/**
 * `qj plugin list` (REQ-GEN-11/AC3): every official plugin with its version and where it is (part of this
 * installation, installed, or missing), and which settings of the current project need it.
 *
 * @returns 0, or 3 on errors.
 */
export async function runPluginList(
  io: CommandIO,
  ports: RuntimePorts,
  project: LoadedProject | undefined,
): Promise<number> {
  try {
    const { root, catalogue } = pluginHome(ports);
    const loader = pluginLoader(ports);
    const needs = project ? pluginNeeds(project.config, await knowledgeOf(project)) : [];
    const installed = await readInstalledPlugins(root);
    const lines = ["Plugins:"];
    for (const id of Object.keys(catalogue.plugins)) {
      const found = await loader.availability(id);
      const record = installed.find((p) => p.id === id);
      const where = found
        ? found.source === "bundled"
          ? `${found.version} part of this installation`
          : `${found.version} installed from ${record?.source === "file" ? record.from : "the registry"}`
        : "not installed";
      const why = needs.filter((n) => n.id === id).map((n) => n.setting);
      lines.push(
        `  ${found ? "✔" : why.length > 0 ? "✘" : "·"} ${id.padEnd(22)} ${where}${why.length > 0 ? `; needed by ${why.join(", ")}` : ""}`,
      );
    }
    io.write(`${lines.join("\n")}\n`);
    return 0;
  } catch (error) {
    return fail(io, error);
  }
}

/**
 * `qj plugin add <id...> [--file <tarball>]` (REQ-GEN-11/AC3): installs official plugins at the version this release
 * pins, checked against their published checksums and without install scripts; `--file` installs a tarball by path
 * (a build of this repository, an offline copy), recorded with its own checksum.
 *
 * @returns 0 all installed, 3 on errors.
 */
export async function runPluginAdd(
  ids: readonly string[],
  options: { readonly file?: string | undefined },
  io: CommandIO,
  ports: RuntimePorts,
  project: LoadedProject | undefined,
): Promise<number> {
  try {
    const { root, catalogue } = pluginHome(ports);
    if (options.file !== undefined && ids.length !== 1)
      throw new QajitsuError(
        "PLUGIN_ARGS",
        "--file installs one plugin: qj plugin add <id> --file <tarball>.",
        {},
      );
    const iports = await installPorts(ports, project);
    for (const id of ids) {
      const entry = catalogueEntry(catalogue, id);
      const found = await pluginLoader(ports).availability(entry.id);
      if (found?.source === "bundled" && options.file === undefined) {
        io.write(`${entry.id} ${found.version} is part of this installation; nothing to install.\n`);
        continue;
      }
      const record = await installPlugin({
        root,
        id: entry.id,
        source:
          options.file === undefined
            ? { kind: "registry", package: entry.package, version: entry.version }
            : { kind: "file", path: resolve(io.cwd, options.file) },
        expectedPackage: entry.package,
        hostPackages: HOST_PACKAGES,
        ports: iports,
      });
      io.write(
        `Installed ${record.id} ${record.version} (${record.integrity.slice(0, 20)}...) into ${record.path}\n`,
      );
      // REQ-GEN-11/AC3: the plugins it needs come with it.
      for (const required of await installRequirements(record, {
        root,
        catalogue,
        ports,
        iports,
        log: (line) => {
          io.write(`${line}\n`);
        },
      }))
        io.write(`Installed ${required}, which ${record.id} needs\n`);
    }
    return 0;
  } catch (error) {
    return fail(io, error);
  }
}

/**
 * `qj plugin remove <id>` (REQ-GEN-11/AC10): refused for a plugin that comes with the installation and while a
 * registered project's settings use the plugin; otherwise
 * its files are deleted and the removal recorded.
 *
 * @returns 0 removed, 3 refused or on errors.
 */
export async function runPluginRemove(id: string, io: CommandIO, ports: RuntimePorts): Promise<number> {
  try {
    const { root, catalogue } = pluginHome(ports);
    const entry = catalogueEntry(catalogue, id);
    if ((await pluginLoader(ports).availability(entry.id))?.source === "bundled")
      throw new QajitsuError(
        "PLUGIN_BUNDLED",
        `${entry.id} comes with this installation and cannot be removed; it moves out into a plugin in a later release.`,
        { plugin: entry.id },
      );
    const removed = await removePlugin({
      root,
      id: entry.id,
      usedBy: await usersOf(entry.id, ports, io.cwd),
      now: ports.now,
    });
    io.write(`Removed ${removed.id} ${removed.version}.\n`);
    return 0;
  } catch (error) {
    return fail(io, error);
  }
}
