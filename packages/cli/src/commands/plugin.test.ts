import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectPaths,
  registerProject,
  resolveProject,
  setActiveProject,
  writeKnowledgeSources,
} from "@qajitsu/core";
import type { RunExec } from "@qajitsu/toolchain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProgram } from "../program.js";
import type { RuntimePorts } from "../adapters.js";
import { readCatalogue } from "../plugins/catalogue.js";
import { bundledPackageDir, createPluginLoader } from "../plugins/load.js";
import { packageJsonFromTarball } from "../plugins/tarball.js";
import { loadProject } from "../project.js";
import { optionalPlugin, pluginCheck, pluginVersions } from "./plugin.js";
import { npmTarball } from "../../../../tests/support/npm-tarball.js";

const LANCE = "@qajitsu/adapter-knowledge-lancedb";
const TARBALL = npmTarball({
  "package.json": {
    name: LANCE,
    version: "0.0.0",
    qajitsu: { plugin: { types: ["knowledge store"], core_api: "^1.0.0" } },
  },
});
const integrity = `sha512-${createHash("sha512").update(TARBALL).digest("base64")}`;

let home: string;
let qjHome: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "qj-plugin-cli-"));
  qjHome = join(home, ".qajitsu");
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** The demo project with a knowledge base, so it needs the LanceDB store. */
async function project(knowledge = true): Promise<void> {
  const qa = join(home, "repo", ".qa");
  await mkdir(qa, { recursive: true });
  await writeFile(
    join(qa, "qa.project.yaml"),
    "project: shop\njira: { type: file, tickets_dir: t, project_key: SHOP }\n",
  );
  await registerProject(qjHome, { slug: "shop", qaDir: qa });
  await setActiveProject(qjHome, "shop");
  if (knowledge) await mkdir(projectPaths(qjHome, "shop").knowledge, { recursive: true });
}

/** This installation without LanceDB: every other official plugin is still part of it. */
const loader = () =>
  createPluginLoader({
    root: join(qjHome, "plugins"),
    catalogue: readCatalogue(),
    bundled: (name) => (name === LANCE ? undefined : bundledPackageDir(name)),
    importModule: () => Promise.resolve({}),
  });

/** npm putting the plugin into the staging folder. */
const npm: RunExec = async (_cmd, args) => {
  const prefix = args[args.indexOf("--prefix") + 1] ?? "";
  const dir = join(prefix, "node_modules", "@qajitsu", "adapter-knowledge-lancedb");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: LANCE,
      version: "0.0.0",
      qajitsu: { plugin: { types: ["knowledge store"], core_api: "^1.0.0" } },
    }),
  );
  await writeFile(join(prefix, "package.json"), JSON.stringify({ dependencies: { [LANCE]: "file:x.tgz" } }));
  return { code: 0, stdout: "", stderr: "" };
};

const registry: typeof fetch = (input) => {
  const url = input instanceof Request ? input.url : input.toString();
  if (url === "https://registry.npmjs.org/@qajitsu%2fadapter-knowledge-lancedb/0.0.0")
    return Promise.resolve(
      Response.json({ dist: { tarball: "https://registry.npmjs.org/lance.tgz", integrity } }),
    );
  if (url === "https://registry.npmjs.org/lance.tgz") return Promise.resolve(new Response(TARBALL));
  return Promise.resolve(new Response("", { status: 404 }));
};

function ports(plugins = loader()): RuntimePorts {
  return {
    env: {},
    home,
    now: () => new Date("2026-11-01T10:00:00.000Z"),
    random: () => 0,
    fetch: registry,
    gitExec: () => Promise.resolve({ stdout: "", stderr: "" }),
    versionExec: (cmd) => Promise.resolve(cmd === "sysctl" ? "1" : undefined),
    playwright: () => ({ version: "1.63.0", browsers: [] }),
    toolchain: {
      host: { os: "darwin", arch: "arm64" },
      run: npm,
      freeBytes: () => Promise.resolve(500 * 1024 ** 3),
    },
    plugins,
  };
}

async function qj(args: string[], p: RuntimePorts = ports()) {
  let out = "";
  let err = "";
  let exitCode = 0;
  const program = createProgram("1.2.3", {
    write: (t) => (out += t),
    writeError: (t) => (err += t),
    cwd: home,
    nodeVersion: "v22.22.0",
    setExitCode: (c) => (exitCode = c),
    ports: p,
  }).exitOverride();
  await program.parseAsync(["node", "qajitsu", ...args]).catch(() => undefined);
  return { out, err, exitCode };
}

const loaded = async () => loadProject(home, await resolveProject(qjHome, { flag: "shop" }));

describe("qj plugin (REQ-GEN-11)", () => {
  it("REQ-GEN-11/AC2: doctor names the missing plugin with its setting and the command that installs it", async () => {
    await project();
    const check = await pluginCheck(await loaded(), ports());
    expect(check.ok).toBe(false);
    expect(check.detail).toBe(
      "knowledge-lancedb missing (knowledge.store: lancedb): qj plugin add knowledge-lancedb",
    );
    await rm(projectPaths(qjHome, "shop").knowledge, { recursive: true });
    expect((await pluginCheck(await loaded(), ports())).ok).toBe(true);
  });

  it("REQ-GEN-11/AC2: an online knowledge source needs its plugin", async () => {
    await project();
    await writeKnowledgeSources(projectPaths(qjHome, "shop").knowledge, [
      {
        name: "shop-wiki",
        kind: "confluence",
        path: "confluence:SHOP",
        include: [],
        exclude: [],
        tags: [],
        added_at: "2026-11-03T10:00:00.000Z",
      },
    ]);
    const r = await qj(["plugin", "list"]);
    expect(r.out).toMatch(
      /knowledge-confluence\s+0\.0\.0 part of this installation; needed by knowledge source confluence:SHOP/,
    );
  });

  it("REQ-GEN-11/AC3: plugin list shows every plugin, where it is and what needs it", async () => {
    await project();
    const r = await qj(["plugin", "list"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/✘ knowledge-lancedb\s+not installed; needed by knowledge\.store: lancedb/);
    expect(r.out).toMatch(/✔ runner-api\s+0\.0\.0 part of this installation; needed by test runs/);
    expect(r.out).toMatch(/✔ secrets-vault\s+0\.0\.0 part of this installation$/m);
  });

  it("REQ-GEN-11/AC3: plugin add installs the pinned version; a plugin of the installation needs nothing", async () => {
    await project();
    const p = ports();
    const added = await qj(["plugin", "add", "knowledge-lancedb"], p);
    expect(added.exitCode).toBe(0);
    expect(added.out).toContain("Installed knowledge-lancedb 0.0.0");
    expect((await qj(["plugin", "list"], p)).out).toMatch(
      /✔ knowledge-lancedb\s+0\.0\.0 installed from the registry/,
    );
    const bundled = await qj(["plugin", "add", "codehost-local"], p);
    expect(bundled.out).toContain("codehost-local 0.0.0 is part of this installation; nothing to install.");
    const unknown = await qj(["plugin", "add", "teleporter"], p);
    expect(unknown.exitCode).toBe(3);
    expect(unknown.err).toContain("[PLUGIN_UNKNOWN]");
  });

  it("REQ-GEN-11/AC5: a run records the plugins it uses with their versions and sources", async () => {
    await project();
    const p = ports();
    expect(await pluginVersions(await loaded(), p)).toMatchObject({
      "plugin knowledge-lancedb": "missing",
      "plugin runner-api": "0.0.0 (bundled)",
    });
    await qj(["plugin", "add", "knowledge-lancedb"], p);
    expect((await pluginVersions(await loaded(), p))["plugin knowledge-lancedb"]).toBe("0.0.0 (installed)");
  });

  it("REQ-GEN-11/AC10: remove is refused while a project uses the plugin, then deletes it", async () => {
    await project();
    const p = ports();
    await qj(["plugin", "add", "knowledge-lancedb"], p);
    const refused = await qj(["plugin", "remove", "knowledge-lancedb"], p);
    expect(refused.exitCode).toBe(3);
    expect(refused.err).toContain("[PLUGIN_IN_USE]");
    expect(refused.err).toContain("shop: knowledge.store: lancedb");
    await rm(projectPaths(qjHome, "shop").knowledge, { recursive: true });
    const removed = await qj(["plugin", "remove", "knowledge-lancedb"], p);
    expect(removed.exitCode).toBe(0);
    expect(removed.out).toContain("Removed knowledge-lancedb 0.0.0.");
    expect(existsSync(join(qjHome, "plugins", "knowledge-lancedb"))).toBe(false);
  });

  it("REQ-GEN-11/AC10: a plugin that comes with the installation cannot be removed", async () => {
    await project();
    const r = await qj(["plugin", "remove", "codehost-local"]);
    expect(r.exitCode).toBe(3);
    expect(r.err).toContain("[PLUGIN_BUNDLED]");
    expect(r.err).toContain("codehost-local comes with this installation");
  });

  it("REQ-GEN-11/AC3: qj setup installs the plugins the project needs; --check only names them", async () => {
    await project();
    const p = ports();
    const check = await qj(["setup", "--check"], p);
    expect(check.out).toContain("plugin knowledge-lancedb: would install (knowledge.store: lancedb)");
    expect(existsSync(join(qjHome, "plugins", "knowledge-lancedb"))).toBe(false);
    const setup = await qj(["setup", "--yes"], p);
    expect(setup.out).toContain("✔ plugin knowledge-lancedb installed");
    expect(existsSync(join(qjHome, "plugins", "knowledge-lancedb", "0.0.0"))).toBe(true);
  });

  it("REQ-GEN-11/AC2: a knowledge command without its store plugin stops with the install command", async () => {
    await project();
    const r = await qj(["knowledge", "list"]);
    expect(r.exitCode).toBe(3);
    expect(r.err).toContain("[PLUGIN_MISSING]");
    expect(r.err).toContain("qj plugin add knowledge-lancedb");
  });

  it("REQ-GEN-11/AC2: work that needs nothing without a plugin skips it instead of failing", async () => {
    expect(await optionalPlugin(loader(), "knowledge-lancedb")).toBeUndefined();
    expect(await optionalPlugin(loader(), "codehost-local")).toEqual({});
  });

  it("REQ-GEN-11/AC3: plugin add also installs the plugins a plugin needs", async () => {
    await project(false);
    const web = {
      name: "@qajitsu/adapter-runner-web",
      version: "0.0.0",
      peerDependencies: { "@qajitsu/adapter-runner-api": "*" },
      qajitsu: { plugin: { types: ["runner"], core_api: "^1.0.0" } },
    };
    const api = {
      name: "@qajitsu/adapter-runner-api",
      version: "0.0.0",
      qajitsu: { plugin: { types: ["runner"], core_api: "^1.0.0" } },
    };
    const tarballs: Record<string, Uint8Array> = {
      web: npmTarball({ "package.json": web }),
      api: npmTarball({ "package.json": api }),
    };
    const sha = (t: Uint8Array) => `sha512-${createHash("sha512").update(t).digest("base64")}`;
    const fetchBoth: typeof fetch = (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      for (const [key, pkg] of [
        ["web", web],
        ["api", api],
      ] as const) {
        if (url === `https://registry.npmjs.org/${pkg.name.replace("/", "%2f")}/0.0.0`)
          return Promise.resolve(
            Response.json({
              dist: {
                tarball: `https://registry.npmjs.org/${key}.tgz`,
                integrity: sha(tarballs[key] ?? new Uint8Array()),
              },
            }),
          );
        if (url === `https://registry.npmjs.org/${key}.tgz`)
          return Promise.resolve(new Response(tarballs[key]));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    };
    const npmAny: RunExec = async (_cmd, args) => {
      const prefix = args[args.indexOf("--prefix") + 1] ?? "";
      const pkg = packageJsonFromTarball(new Uint8Array(await readFile(args.at(-1) ?? ""))) as {
        name: string;
      };
      const dir = join(prefix, "node_modules", ...pkg.name.split("/"));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), JSON.stringify(pkg));
      return { code: 0, stdout: "", stderr: "" };
    };
    const p: RuntimePorts = {
      ...ports(
        createPluginLoader({
          root: join(qjHome, "plugins"),
          catalogue: readCatalogue(),
          bundled: () => undefined,
        }),
      ),
      fetch: fetchBoth,
      toolchain: { host: { os: "darwin", arch: "arm64" }, run: npmAny },
    };
    const r = await qj(["plugin", "add", "runner-web"], p);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("Installed runner-web 0.0.0");
    expect(r.out).toContain("Installed runner-api, which runner-web needs");
    expect(existsSync(join(qjHome, "plugins", "runner-api", "0.0.0"))).toBe(true);
  });

  it("REQ-GEN-11/AC1: qj init installs the official plugins the chosen setup needs", async () => {
    const pkgs = ["ticket-jira", "publish-jira"].map((id) => ({
      id,
      pkg: {
        name: `@qajitsu/adapter-${id}`,
        version: "0.0.0",
        qajitsu: { plugin: { types: ["ticket source"], core_api: "^1.0.0" } },
      },
    }));
    const tarballs = new Map(pkgs.map((p) => [p.id, npmTarball({ "package.json": p.pkg })]));
    const sha = (t: Uint8Array) => `sha512-${createHash("sha512").update(t).digest("base64")}`;
    const registryOfJira: typeof fetch = (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      for (const { id, pkg } of pkgs) {
        const t = tarballs.get(id) ?? new Uint8Array();
        if (url === `https://registry.npmjs.org/${pkg.name.replace("/", "%2f")}/0.0.0`)
          return Promise.resolve(
            Response.json({ dist: { tarball: `https://registry.npmjs.org/${id}.tgz`, integrity: sha(t) } }),
          );
        if (url === `https://registry.npmjs.org/${id}.tgz`) return Promise.resolve(new Response(t));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    };
    const npmAny: RunExec = async (_cmd, args) => {
      const prefix = args[args.indexOf("--prefix") + 1] ?? "";
      const pkg = packageJsonFromTarball(new Uint8Array(await readFile(args.at(-1) ?? ""))) as {
        name: string;
      };
      const dir = join(prefix, "node_modules", ...pkg.name.split("/"));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), JSON.stringify(pkg));
      return { code: 0, stdout: "", stderr: "" };
    };
    const missingJira = createPluginLoader({
      root: join(qjHome, "plugins"),
      catalogue: readCatalogue(),
      bundled: (name) => (name.includes("-jira") ? undefined : bundledPackageDir(name)),
      importModule: () => Promise.resolve({}),
    });
    const repo = join(home, "shop");
    await mkdir(repo, { recursive: true });
    const r = await qj(
      [
        "init",
        "shop",
        "--yes",
        "--qa-dir",
        join(repo, ".qa"),
        "--jira-url",
        "https://shop.atlassian.net",
        "--project-key",
        "SHOP",
      ],
      {
        ...ports(missingJira),
        fetch: registryOfJira,
        toolchain: { host: { os: "darwin", arch: "arm64" }, run: npmAny },
      },
    );
    expect(r.out).toContain("plugin ticket-jira: installing @qajitsu/adapter-ticket-jira@0.0.0");
    expect(r.out).toContain("plugin publish-jira: installing @qajitsu/adapter-publish-jira@0.0.0");
    expect(existsSync(join(qjHome, "plugins", "ticket-jira", "0.0.0"))).toBe(true);
    expect(existsSync(join(qjHome, "plugins", "publish-jira", "0.0.0"))).toBe(true);
  });

  it("REQ-GEN-11/AC6: setup --download puts the plugins into the bundle; setup --from installs them offline", async () => {
    await project();
    const bundle = join(home, "bundle");
    const download = await qj(["setup", "--download", bundle, "--yes"]);
    expect(download.out + download.err).toContain("plugin knowledge-lancedb: into the bundle");
    expect(existsSync(join(bundle, "plugins", "knowledge-lancedb", "0.0.0"))).toBe(true);
    // The offline machine: no network, nothing installed yet.
    await rm(join(qjHome, "plugins"), { recursive: true, force: true });
    const offline: RuntimePorts = { ...ports(), fetch: () => Promise.reject(new Error("offline")) };
    const imported = await qj(["setup", "--from", bundle, "--yes"], offline);
    expect(imported.out + imported.err).toContain(
      "✔ plugin knowledge-lancedb 0.0.0 installed from the bundle",
    );
    expect((await pluginCheck(await loaded(), offline)).ok).toBe(true);
    const history = await readFile(join(qjHome, "plugins", "history.jsonl"), "utf8");
    expect(history).toContain("offline bundle");
  });
});
