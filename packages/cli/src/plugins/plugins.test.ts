import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION, ProjectConfigSchema, type PluginError } from "@qajitsu/core";
import type { RunExec } from "@qajitsu/toolchain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catalogueEntry, readCatalogue, type PluginCatalogue } from "./catalogue.js";
import { installPlugin, removePlugin, type PluginInstallPorts } from "./install.js";
import { bundledPackageDir, createPluginLoader, linkHostPackages } from "./load.js";
import { pluginNeeds } from "./needs.js";
import { readInstalledPlugins } from "./store.js";

const PKG = "@qajitsu/adapter-knowledge-lancedb";
const catalogue: PluginCatalogue = {
  schema: 1,
  plugins: { "knowledge-lancedb": { package: PKG, version: "1.2.3" } },
};
const TARBALL = new TextEncoder().encode("fake tarball bytes");
const urlOf = (input: string | URL | Request): string =>
  input instanceof Request ? input.url : input.toString();
const integrity = (data: Uint8Array): string =>
  `sha512-${createHash("sha512").update(data).digest("base64")}`;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "qj-plugins-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const manifest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: PKG,
  version: "1.2.3",
  type: "module",
  exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  qajitsu: {
    plugin: {
      types: ["knowledge store"],
      core_api: "^1.0.0",
      secrets: [],
      hosts: [],
      permissions: ["filesystem"],
    },
  },
  ...overrides,
});

/** npm as the installer sees it: puts the package (and a bundled copy of core) into the staging folder. */
const fakeNpm =
  (pkg: Record<string, unknown> = manifest(), calls: string[][] = []): RunExec =>
  async (cmd, args) => {
    calls.push([cmd, ...args]);
    const prefix = args[args.indexOf("--prefix") + 1] ?? "";
    const dir = join(prefix, "node_modules", ...String(pkg["name"]).split("/"));
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify(pkg));
    await writeFile(join(dir, "dist", "index.js"), "export const ok = true;\n");
    await mkdir(join(prefix, "node_modules", "@qajitsu", "core"), { recursive: true });
    await writeFile(join(prefix, "node_modules", "@qajitsu", "core", "package.json"), "{}");
    await writeFile(
      join(prefix, "package.json"),
      JSON.stringify({ dependencies: { [String(pkg["name"])]: "file:x.tgz" } }),
    );
    return { code: 0, stdout: "", stderr: "" };
  };

/** A registry that publishes the tarball with the given integrity. */
const fakeRegistry =
  (published: string = integrity(TARBALL), data: Uint8Array = TARBALL): typeof fetch =>
  (input) => {
    const url = urlOf(input);
    if (url === `https://registry.example/${PKG.replace("/", "%2f")}/1.2.3`)
      return Promise.resolve(
        Response.json({
          dist: { tarball: "https://registry.example/lancedb-1.2.3.tgz", integrity: published },
        }),
      );
    if (url === "https://registry.example/lancedb-1.2.3.tgz") return Promise.resolve(new Response(data));
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

const ports = (overrides: Partial<PluginInstallPorts> = {}): PluginInstallPorts => ({
  fetch: fakeRegistry(),
  run: fakeNpm(),
  now: () => new Date("2026-11-01T10:00:00Z"),
  registry: "https://registry.example",
  ...overrides,
});

const install = (p: PluginInstallPorts = ports()) =>
  installPlugin({
    root,
    id: "knowledge-lancedb",
    source: { kind: "registry", package: PKG, version: "1.2.3" },
    expectedPackage: PKG,
    hostPackages: ["@qajitsu/core"],
    ports: p,
  });

const failure = async (p: Promise<unknown>): Promise<PluginError> => {
  try {
    await p;
  } catch (error) {
    return error as PluginError;
  }
  throw new Error("expected a failure");
};

describe("plugins: install, load, remove (REQ-GEN-11)", () => {
  it("REQ-GEN-11/AC3: installs the pinned version checked against its published checksum, without install scripts", async () => {
    const calls: string[][] = [];
    const record = await install(ports({ run: fakeNpm(manifest(), calls) }));
    expect(record).toMatchObject({
      id: "knowledge-lancedb",
      package: PKG,
      version: "1.2.3",
      source: "registry",
      integrity: integrity(TARBALL),
      path: join(root, "knowledge-lancedb", "1.2.3"),
    });
    expect(calls[0]).toContain("--ignore-scripts");
    expect(calls[0]?.[0]).toBe("npm");
    expect(await readInstalledPlugins(root)).toEqual([record]);
    const history = (await readFile(join(root, "history.jsonl"), "utf8")).trim().split("\n");
    expect(JSON.parse(history[0] ?? "{}")).toMatchObject({
      action: "add",
      id: "knowledge-lancedb",
      version: "1.2.3",
    });
  });

  it("REQ-GEN-11/AC4: the plugin's own copies of QAJitsu's packages are removed, the installation's are linked", async () => {
    const record = await install();
    expect(existsSync(join(record.path, "node_modules", "@qajitsu", "core"))).toBe(false);
    const coreDir = join(root, "host-core");
    await mkdir(coreDir);
    await linkHostPackages(root, { "@qajitsu/core": coreDir });
    await linkHostPackages(root, { "@qajitsu/core": coreDir });
    expect(await readlink(join(root, "node_modules", "@qajitsu", "core"))).toBe(coreDir);
  });

  it("REQ-GEN-11/AC3: a tarball that does not match its published checksum is never installed", async () => {
    const err = await failure(
      install(ports({ fetch: fakeRegistry(integrity(new TextEncoder().encode("other"))) })),
    );
    expect(err.code).toBe("PLUGIN_CHECKSUM_MISMATCH");
    expect(await readInstalledPlugins(root)).toEqual([]);
    expect(existsSync(join(root, "knowledge-lancedb"))).toBe(false);
  });

  it("REQ-GEN-11/AC3: a tarball on another host than the registry is never downloaded", async () => {
    const fetched: string[] = [];
    const elsewhere: typeof fetch = (input) => {
      fetched.push(urlOf(input));
      return Promise.resolve(
        Response.json({ dist: { tarball: "https://evil.example/x.tgz", integrity: integrity(TARBALL) } }),
      );
    };
    expect((await failure(install(ports({ fetch: elsewhere })))).code).toBe("PLUGIN_DOWNLOAD_FAILED");
    expect(fetched.some((u) => u.startsWith("https://evil.example"))).toBe(false);
  });

  it("REQ-GEN-11/AC3: a version without a published sha512 checksum is refused", async () => {
    expect((await failure(install(ports({ fetch: fakeRegistry("sha1-abc") })))).code).toBe(
      "PLUGIN_NO_CHECKSUM",
    );
  });

  it("REQ-GEN-11/AC3: a version the registry does not have, or a failed download, is named", async () => {
    const missing = await failure(
      installPlugin({
        root,
        id: "knowledge-lancedb",
        source: { kind: "registry", package: PKG, version: "9.9.9" },
        hostPackages: [],
        ports: ports(),
      }),
    );
    expect(missing.code).toBe("PLUGIN_NOT_PUBLISHED");
    const noTarball: typeof fetch = (input) =>
      urlOf(input).endsWith(".tgz")
        ? Promise.resolve(new Response("gone", { status: 410 }))
        : fakeRegistry()(input);
    expect((await failure(install(ports({ fetch: noTarball })))).code).toBe("PLUGIN_DOWNLOAD_FAILED");
  });

  it("REQ-GEN-11/AC3: an npm failure leaves nothing behind", async () => {
    const run: RunExec = () => Promise.resolve({ code: 1, stdout: "", stderr: "npm ERR! network\nE404" });
    const err = await failure(install(ports({ run })));
    expect(err.code).toBe("PLUGIN_INSTALL_FAILED");
    expect(err.message).toContain("E404");
    expect(await readInstalledPlugins(root)).toEqual([]);
  });

  it("REQ-GEN-11/AC8: a plugin for another core API version is refused at install", async () => {
    const run = fakeNpm(
      manifest({ qajitsu: { plugin: { types: ["knowledge store"], core_api: "^2.0.0" } } }),
    );
    const err = await failure(install(ports({ run })));
    expect(err.code).toBe("PLUGIN_INCOMPATIBLE");
    expect(err.message).toContain(PLUGIN_API_VERSION);
    expect(await readInstalledPlugins(root)).toEqual([]);
  });

  it("REQ-GEN-11/AC7: a package without a manifest is refused at install", async () => {
    const run = fakeNpm(manifest({ qajitsu: undefined }));
    expect((await failure(install(ports({ run })))).code).toBe("PLUGIN_MANIFEST_INVALID");
  });

  it("REQ-GEN-11/AC3: a tarball by path is recorded with its own checksum; it must contain one package", async () => {
    const file = join(root, "local.tgz");
    await writeFile(file, TARBALL);
    const record = await installPlugin({
      root,
      id: "knowledge-lancedb",
      source: { kind: "file", path: file },
      hostPackages: [],
      ports: ports(),
    });
    expect(record).toMatchObject({ source: "file", from: file, integrity: integrity(TARBALL) });
    const empty: RunExec = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });
    const err = await failure(
      installPlugin({
        root,
        id: "knowledge-lancedb",
        source: { kind: "file", path: file },
        hostPackages: [],
        ports: ports({ run: empty }),
      }),
    );
    expect(err.code).toBe("PLUGIN_WRONG_PACKAGE");
  });

  it("REQ-GEN-11/AC2: a missing plugin stops with the command that installs it, not a module error", async () => {
    const loader = createPluginLoader({ root, catalogue, bundled: () => undefined });
    expect(await loader.availability("knowledge-lancedb")).toBeUndefined();
    const err = await failure(loader.load("knowledge-lancedb"));
    expect(err.code).toBe("PLUGIN_MISSING");
    expect(err.message).toContain("qj plugin add knowledge-lancedb");
    expect((await failure(loader.load("teleporter"))).code).toBe("PLUGIN_UNKNOWN");
  });

  it("REQ-GEN-11/AC5: a bundled plugin is imported as it is and remembered as used", async () => {
    const dir = join(root, "bundled");
    await mkdir(dir);
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: PKG, version: "0.0.7" }));
    const imported: string[] = [];
    const loader = createPluginLoader({
      root,
      catalogue,
      bundled: (n) => (n === PKG ? dir : undefined),
      importModule: (s) => {
        imported.push(s);
        return Promise.resolve({ ok: true });
      },
    });
    expect(await loader.load<{ ok: boolean }>("knowledge-lancedb")).toEqual({ ok: true });
    await loader.load(PKG);
    expect(imported).toEqual([PKG, PKG]);
    expect(loader.used()).toEqual([
      { id: "knowledge-lancedb", package: PKG, version: "0.0.7", source: "bundled" },
    ]);
  });

  it("REQ-GEN-11/AC2: an installed plugin is imported from its folder with QAJitsu's packages linked", async () => {
    const record = await install();
    const coreDir = join(root, "host-core");
    await mkdir(coreDir);
    const imported: string[] = [];
    const loader = createPluginLoader({
      root,
      catalogue,
      bundled: () => undefined,
      hostDirs: () => ({ "@qajitsu/core": coreDir }),
      importModule: (s) => {
        imported.push(s);
        return Promise.resolve({});
      },
    });
    await loader.load("knowledge-lancedb");
    expect(imported[0]).toBe(
      `file://${join(record.path, "node_modules", "@qajitsu", "adapter-knowledge-lancedb", "dist", "index.js")}`,
    );
    expect(await readlink(join(root, "node_modules", "@qajitsu", "core"))).toBe(coreDir);
    expect(loader.used()[0]).toMatchObject({ source: "installed", version: "1.2.3" });
  });

  it("REQ-GEN-11/AC8: an installed plugin whose core API range no longer matches is refused when loaded", async () => {
    const record = await install();
    const pj = join(record.path, "node_modules", "@qajitsu", "adapter-knowledge-lancedb", "package.json");
    await writeFile(
      pj,
      JSON.stringify(manifest({ qajitsu: { plugin: { types: ["knowledge store"], core_api: "^0.1.0" } } })),
    );
    const loader = createPluginLoader({
      root,
      catalogue,
      bundled: () => undefined,
      importModule: () => Promise.resolve({}),
    });
    const err = await failure(loader.load("knowledge-lancedb"));
    expect(err.code).toBe("PLUGIN_INCOMPATIBLE");
    expect(err.message).toContain("qj plugin add knowledge-lancedb");
  });

  it("REQ-GEN-11/AC10: removing a plugin a project uses is refused with the projects and settings", async () => {
    await install();
    const err = await failure(
      removePlugin({
        root,
        id: "knowledge-lancedb",
        usedBy: ["shop: knowledge.store: lancedb"],
        now: () => new Date(),
      }),
    );
    expect(err.code).toBe("PLUGIN_IN_USE");
    expect(err.message).toContain("shop: knowledge.store: lancedb");
    expect(existsSync(join(root, "knowledge-lancedb"))).toBe(true);
  });

  it("REQ-GEN-11/AC10: removing an unused plugin deletes its files and records it", async () => {
    await install();
    await removePlugin({
      root,
      id: "knowledge-lancedb",
      usedBy: [],
      now: () => new Date("2026-11-02T00:00:00Z"),
    });
    expect(existsSync(join(root, "knowledge-lancedb"))).toBe(false);
    expect(await readInstalledPlugins(root)).toEqual([]);
    const lines = (await readFile(join(root, "history.jsonl"), "utf8")).trim().split("\n");
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
      action: "remove",
      id: "knowledge-lancedb",
      at: "2026-11-02T00:00:00.000Z",
    });
    expect(
      (await failure(removePlugin({ root, id: "knowledge-lancedb", usedBy: [], now: () => new Date() })))
        .code,
    ).toBe("PLUGIN_NOT_INSTALLED");
  });

  it("REQ-GEN-11/AC2: a project's settings name the plugins it needs", () => {
    const config = ProjectConfigSchema.parse({
      project: "shop",
      jira: {
        type: "cloud",
        base_url: "https://shop.atlassian.net",
        email: "secret://env/E",
        token: "secret://env/T",
        project_key: "SHOP",
      },
      code_hosts: { gh: { type: "github", token: "secret://env/GH" } },
      secrets: { vault: { address: "https://vault.example", token: "secret://env/VAULT_TOKEN" } },
      test_cases: [{ type: "xray", client_id: "secret://env/X", client_secret: "secret://env/Y" }],
    });
    const needs = pluginNeeds(config, { knowledge: true });
    expect(needs).toEqual(
      expect.arrayContaining([
        { id: "ticket-jira", setting: "jira.type: cloud" },
        { id: "publish-jira", setting: "jira.type: cloud" },
        { id: "codehost-github", setting: "code_hosts.gh.type: github" },
        { id: "secrets-vault", setting: "secrets.vault" },
        { id: "testcases", setting: "test_cases[0].type: xray" },
        { id: "knowledge-lancedb", setting: "knowledge.store: lancedb" },
        { id: "runner-api", setting: "API cases" },
      ]),
    );
    expect(pluginNeeds(config, { knowledge: false }).map((n) => n.id)).not.toContain("knowledge-lancedb");
  });

  it("REQ-GEN-11/AC3: the shipped catalogue pins every adapter package at its version", async () => {
    const cat = readCatalogue();
    const adapters = join(import.meta.dirname, "..", "..", "..", "adapters");
    for (const [id, entry] of Object.entries(cat.plugins)) {
      const pkg = JSON.parse(await readFile(join(adapters, id, "package.json"), "utf8")) as {
        name: string;
        version: string;
      };
      // Stale after `changeset version`: run `pnpm plugins:catalogue`.
      expect({ id, ...entry }).toEqual({ id, package: pkg.name, version: pkg.version });
    }
    expect(catalogueEntry(cat, "@qajitsu/adapter-knowledge-lancedb").id).toBe("knowledge-lancedb");
  });

  it("REQ-GEN-11/AC2: the installation's own packages are found where Node resolves them", () => {
    expect(bundledPackageDir("@qajitsu/adapter-knowledge-lancedb")).toMatch(
      /packages\/adapters\/knowledge-lancedb$/,
    );
    expect(bundledPackageDir("@qajitsu/core")).toMatch(/packages\/core$/);
    expect(bundledPackageDir("@qajitsu/adapter-not-there")).toBeUndefined();
  });
});
