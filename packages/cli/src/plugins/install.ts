import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { PLUGIN_API_VERSION, PluginError, parsePluginManifest, type PluginManifest } from "@qajitsu/core";
import { acquireSetupLock, satisfies, type RunExec } from "@qajitsu/toolchain";
import { z } from "zod";
import { packageJsonFromTarball } from "./tarball.js";
import {
  appendPluginHistory,
  readInstalledPlugins,
  writeInstalledPlugins,
  type InstalledPlugin,
} from "./store.js";

/** What installing a plugin uses from the machine; all injected. */
export interface PluginInstallPorts {
  readonly fetch: typeof globalThis.fetch;
  /** Runs npm with an argument array, never a shell. */
  readonly run: RunExec;
  readonly now: () => Date;
  /** The npm registry (a company mirror from the toolchain's `sources.npm_registry`, else the public one). */
  readonly registry: string;
  /** npm's network settings (proxy, CA, token) from the toolchain configuration. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Where a plugin comes from: the version this release pins in the registry, or a tarball by path. */
export type PluginSource =
  | { readonly kind: "registry"; readonly package: string; readonly version: string }
  | { readonly kind: "file"; readonly path: string };

const RegistryVersionSchema = z.object({
  dist: z.object({ tarball: z.url(), integrity: z.string().min(1) }),
});

const MAX_TARBALL = 200 * 1024 * 1024;
const sha512 = (data: Uint8Array): string => `sha512-${createHash("sha512").update(data).digest("base64")}`;

/** The pinned tarball and its published integrity from the registry, checked byte for byte (REQ-GEN-11/AC3). */
async function fromRegistry(
  source: Extract<PluginSource, { kind: "registry" }>,
  ports: PluginInstallPorts,
): Promise<{ data: Uint8Array; integrity: string; from: string }> {
  const base = ports.registry.replace(/\/+$/, "");
  const metaUrl = `${base}/${source.package.replace("/", "%2f")}/${source.version}`;
  const res = await ports.fetch(metaUrl, { headers: { accept: "application/json" } });
  if (!res.ok)
    throw new PluginError(
      "PLUGIN_NOT_PUBLISHED",
      `${source.package}@${source.version} is not in the registry ${base} (HTTP ${String(res.status)}).`,
      { package: source.package, version: source.version },
    );
  const meta = RegistryVersionSchema.parse(await res.json());
  const published = meta.dist.integrity.split(/\s+/).find((i) => i.startsWith("sha512-"));
  // Invariant: nothing is installed without a published checksum to check it against.
  if (published === undefined)
    throw new PluginError(
      "PLUGIN_NO_CHECKSUM",
      `${source.package}@${source.version} has no published sha512 checksum; it is not installed.`,
      { package: source.package },
    );
  // The tarball comes from the registry itself, never from a host its metadata names.
  if (new URL(meta.dist.tarball).origin !== new URL(base).origin)
    throw new PluginError(
      "PLUGIN_DOWNLOAD_FAILED",
      `${source.package}@${source.version}: the registry points to ${new URL(meta.dist.tarball).origin}, not to itself; it is not installed.`,
      { package: source.package },
    );
  const tarball = await ports.fetch(meta.dist.tarball);
  if (!tarball.ok)
    throw new PluginError(
      "PLUGIN_DOWNLOAD_FAILED",
      `Downloading ${source.package}@${source.version} failed (HTTP ${String(tarball.status)}).`,
      { package: source.package },
    );
  const data = new Uint8Array(await tarball.arrayBuffer());
  if (data.byteLength > MAX_TARBALL)
    throw new PluginError("PLUGIN_DOWNLOAD_FAILED", `${source.package} is larger than 200 MB.`, {});
  const actual = sha512(data);
  if (actual !== published)
    throw new PluginError(
      "PLUGIN_CHECKSUM_MISMATCH",
      `${source.package}@${source.version} does not match its published checksum; it is not installed.`,
      { package: source.package, expected: published, actual },
    );
  return { data, integrity: published, from: meta.dist.tarball };
}

/**
 * Installs a plugin into `<root>/<id>/<version>` (REQ-GEN-11/AC3): the tarball is checked against its published
 * checksum, its dependencies are installed by npm without install scripts, its manifest and core API range are
 * checked (AC7, AC8), and only then does it replace an installed version. QAJitsu's own packages (core, steps,
 * guard, verifier...) are removed from the plugin's folder, so the plugin always runs against the installation's
 * copies and cannot bring its own guard or verifier (AC4).
 *
 * @param input - The plugins folder, the plugin id, where it comes from and QAJitsu's own package names.
 * @returns The installed plugin as recorded.
 * @throws {PluginError} `PLUGIN_NOT_PUBLISHED`, `PLUGIN_NO_CHECKSUM`, `PLUGIN_CHECKSUM_MISMATCH`,
 *   `PLUGIN_INSTALL_FAILED`, `PLUGIN_MANIFEST_INVALID`, `PLUGIN_INCOMPATIBLE` or `PLUGIN_WRONG_PACKAGE`.
 */
export async function installPlugin(input: {
  readonly root: string;
  readonly id: string;
  readonly source: PluginSource;
  /** Package name expected in the tarball; a file must contain it too. */
  readonly expectedPackage?: string | undefined;
  readonly hostPackages: readonly string[];
  readonly ports: PluginInstallPorts;
}): Promise<InstalledPlugin> {
  const { root, id, source, ports } = input;
  await mkdir(root, { recursive: true });
  const lock = await acquireSetupLock(root);
  const staging = join(root, `.staging-${id}-${randomBytes(4).toString("hex")}`);
  try {
    const got =
      source.kind === "registry"
        ? await fromRegistry(source, ports)
        : await readFile(source.path).then((b) => {
            const data = new Uint8Array(b);
            return { data, integrity: sha512(data), from: source.path };
          });
    // The manifest is checked from the tarball before npm runs, and again as installed.
    const early = parsePluginManifest(packageJsonFromTarball(got.data));
    if (input.expectedPackage !== undefined && early.name !== input.expectedPackage)
      throw new PluginError(
        "PLUGIN_WRONG_PACKAGE",
        `The tarball contains ${early.name}, not ${input.expectedPackage}.`,
        { expected: input.expectedPackage, found: early.name },
      );
    compatible(id, early);
    await mkdir(staging, { recursive: true });
    // Optional dependencies the plugin never loads are installed as empty packages (npm has no way to skip one).
    const overrides: Record<string, string> = {};
    for (const [i, name] of early.omitOptional.entries()) {
      const stub = join(staging, ".omitted", String(i));
      await mkdir(stub, { recursive: true });
      await writeFile(
        join(stub, "package.json"),
        JSON.stringify({
          name,
          version: "0.0.0-omitted",
          description: "Left out by QAJitsu: the plugin never loads it.",
        }),
      );
      overrides[name] = `file:./.omitted/${String(i)}`;
    }
    await writeFile(
      join(staging, "package.json"),
      JSON.stringify({
        name: "qajitsu-plugin-staging",
        private: true,
        ...(early.omitOptional.length > 0 ? { overrides } : {}),
      }),
    );
    const tgz = join(staging, basename(source.kind === "file" ? source.path : `${id}.tgz`));
    await writeFile(tgz, got.data);
    const res = await ports.run(
      "npm",
      [
        "install",
        "--prefix",
        staging,
        "--ignore-scripts",
        "--omit=dev",
        "--legacy-peer-deps",
        "--install-links",
        "--no-package-lock",
        "--no-fund",
        "--no-audit",
        "--no-update-notifier",
        tgz,
      ],
      { env: { ...ports.env, npm_config_registry: ports.registry } },
    );
    if (res.code !== 0)
      throw new PluginError(
        "PLUGIN_INSTALL_FAILED",
        `npm could not install ${id}: ${(res.stderr || res.stdout).trim().split("\n").slice(-5).join(" ")}`,
        { plugin: id },
      );
    const pkgDir = installedPackageDir(staging, early.name);
    const manifest = parsePluginManifest(
      JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8")) as unknown,
    );
    compatible(id, manifest);
    await rm(join(staging, ".omitted"), { recursive: true, force: true });
    // QAJitsu's own packages and other plugins always come from the installation, never from the plugin's folder.
    const scoped = join(staging, "node_modules", "@qajitsu");
    for (const name of await readdir(scoped).catch(() => [] as string[]))
      if (`@qajitsu/${name}` !== manifest.name)
        await rm(join(scoped, name), { recursive: true, force: true });
    for (const host of input.hostPackages)
      if (!host.startsWith("@qajitsu/"))
        await rm(join(staging, "node_modules", ...host.split("/")), { recursive: true, force: true });
    await rm(tgz, { force: true });
    const target = join(root, id, manifest.version);
    await rm(join(root, id), { recursive: true, force: true });
    await mkdir(join(root, id), { recursive: true });
    await rename(staging, target);
    const record: InstalledPlugin = {
      id,
      package: manifest.name,
      version: manifest.version,
      source: source.kind,
      integrity: got.integrity,
      from: got.from,
      installed_at: ports.now().toISOString(),
      path: target,
      requires: requiredPlugins(packageJsonFromTarball(got.data)),
    };
    const others = (await readInstalledPlugins(root)).filter((p) => p.id !== id);
    await writeInstalledPlugins(root, [...others, record]);
    await appendPluginHistory(root, {
      at: record.installed_at,
      action: "add",
      id,
      version: record.version,
      source: record.from,
      integrity: record.integrity,
    });
    return record;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await lock.release();
  }
}

/** The plugins a plugin needs: its `@qajitsu/adapter-*` peer dependencies, which the installation provides. */
function requiredPlugins(packageJson: unknown): string[] {
  const peers =
    packageJson !== null && typeof packageJson === "object" && "peerDependencies" in packageJson
      ? (packageJson as { peerDependencies?: unknown }).peerDependencies
      : undefined;
  return peers !== null && typeof peers === "object"
    ? Object.keys(peers)
        .filter((n) => n.startsWith("@qajitsu/adapter-"))
        .sort()
    : [];
}

/** A plugin for another range of the core's adapter API is never installed (REQ-GEN-11/AC8). */
function compatible(id: string, manifest: PluginManifest): void {
  if (!satisfies(PLUGIN_API_VERSION, manifest.coreApi))
    throw new PluginError(
      "PLUGIN_INCOMPATIBLE",
      `${manifest.name}@${manifest.version} works with core API ${manifest.coreApi}; this QAJitsu has ${PLUGIN_API_VERSION}. Install the plugin version of this release.`,
      { plugin: id, coreApi: manifest.coreApi, have: PLUGIN_API_VERSION },
    );
}

/** The folder npm installed the tarball's package into; it must be there. */
function installedPackageDir(staging: string, name: string): string {
  const dir = join(staging, "node_modules", ...name.split("/"));
  if (!existsSync(join(dir, "package.json")))
    throw new PluginError("PLUGIN_WRONG_PACKAGE", `npm did not install ${name} from the tarball.`, { name });
  return dir;
}

/**
 * Removes an installed plugin (REQ-GEN-11/AC10): refused while a project uses it, naming the projects and settings;
 * otherwise its folder is deleted and the removal recorded.
 *
 * @param input - The plugins folder, the plugin id and who uses it (`<project>: <setting>`).
 * @throws {PluginError} `PLUGIN_IN_USE` or `PLUGIN_NOT_INSTALLED`.
 */
export async function removePlugin(input: {
  readonly root: string;
  readonly id: string;
  readonly usedBy: readonly string[];
  readonly now: () => Date;
}): Promise<InstalledPlugin> {
  const { root, id } = input;
  if (input.usedBy.length > 0)
    throw new PluginError(
      "PLUGIN_IN_USE",
      `${id} is still used by ${input.usedBy.join("; ")}. Change those settings first.`,
      { plugin: id, usedBy: [...input.usedBy] },
    );
  const lock = await acquireSetupLock(root);
  try {
    const installed = await readInstalledPlugins(root);
    const plugin = installed.find((p) => p.id === id);
    if (!plugin)
      throw new PluginError("PLUGIN_NOT_INSTALLED", `${id} is not installed (qj plugin list).`, {
        plugin: id,
      });
    await rm(join(root, id), { recursive: true, force: true });
    await writeInstalledPlugins(
      root,
      installed.filter((p) => p.id !== id),
    );
    await appendPluginHistory(root, {
      at: input.now().toISOString(),
      action: "remove",
      id,
      version: plugin.version,
    });
    return plugin;
  } finally {
    await lock.release();
  }
}
