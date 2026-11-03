import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_API_VERSION, parsePluginManifest } from "@qajitsu/core";
import { satisfies } from "@qajitsu/toolchain";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(import.meta.url), "../../..");
const adapters = readdirSync(join(root, "packages", "adapters"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

/** Plugin types the inventory gives each package (an entry can list several packages). */
function inventoryTypes(): Map<string, Set<string>> {
  const byPackage = new Map<string, Set<string>>();
  const text = readFileSync(join(root, "docs", "architecture", "plugins.md"), "utf8");
  for (const block of text.split(/^### /m).slice(1)) {
    const types =
      /^- Type: (.*)$/m
        .exec(block)?.[1]
        ?.split(",")
        .map((t) => t.trim()) ?? [];
    const packages =
      /^- Package: (.*)$/m
        .exec(block)?.[1]
        ?.split(",")
        .map((p) => p.trim()) ?? [];
    for (const p of packages) {
      const set = byPackage.get(p) ?? new Set<string>();
      for (const t of types) set.add(t);
      byPackage.set(p, set);
    }
  }
  return byPackage;
}

describe("plugin manifests of the adapter packages (REQ-GEN-11)", () => {
  const types = inventoryTypes();
  it.each(adapters)("REQ-GEN-11/AC7: %s has a valid manifest within the core API", (dir) => {
    const pkg = JSON.parse(
      readFileSync(join(root, "packages", "adapters", dir, "package.json"), "utf8"),
    ) as unknown;
    const manifest = parsePluginManifest(pkg);
    expect(satisfies(PLUGIN_API_VERSION, manifest.coreApi)).toBe(true);
    // The manifest says no more than the inventory (REQ-GEN-14): its types come from the package's entries.
    const allowed = types.get(`packages/adapters/${dir}`) ?? new Set<string>();
    expect(manifest.types.filter((t) => !allowed.has(t))).toEqual([]);
  });

  it.each(adapters)(
    "REQ-GEN-11/AC1: %s, once a plugin, is not a dependency of the published CLI and brings no own core",
    (dir) => {
      const read = (p: string) =>
        JSON.parse(readFileSync(join(root, "packages", p, "package.json"), "utf8")) as {
          name: string;
          dependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
        };
      const pkg = read(`adapters/${dir}`);
      const cli = read("cli");
      const plugin = pkg.peerDependencies?.["@qajitsu/core"] !== undefined;
      // A plugin that moved out uses the installation's core: never its own copy, and the CLI does not carry it.
      if (plugin) {
        expect(Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith("@qajitsu/"))).toEqual([]);
        expect(cli.dependencies?.[pkg.name]).toBeUndefined();
      } else expect(cli.dependencies?.[pkg.name], `${pkg.name} still ships with the CLI`).toBeDefined();
    },
  );

  it("REQ-GEN-11/AC3: playwright-core is pinned to one exact version in the CLI and every plugin that uses it", () => {
    // qj setup installs the browsers of one Playwright version; a plugin resolving a newer one would not find them.
    const versions = ["cli", ...adapters.map((d) => `adapters/${d}`)].flatMap((p) => {
      const pkg = JSON.parse(readFileSync(join(root, "packages", p, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      const v = pkg.dependencies?.["playwright-core"];
      return v === undefined ? [] : [[p, v] as const];
    });
    expect(versions.length).toBeGreaterThan(1);
    for (const [, v] of versions) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    expect(new Set(versions.map(([, v]) => v)).size).toBe(1);
  });

  it("REQ-GEN-11/AC1: the core installation carries only the core adapters; every other integration is a plugin", () => {
    const cli = JSON.parse(readFileSync(join(root, "packages", "cli", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    // The core keeps what works without any external system (docs/architecture/plugins.md, ADR-0011).
    expect(
      Object.keys(cli.dependencies)
        .filter((d) => d.startsWith("@qajitsu/adapter-"))
        .sort(),
    ).toEqual([
      "@qajitsu/adapter-codehost-local",
      "@qajitsu/adapter-env-remote",
      "@qajitsu/adapter-evidence-local",
      "@qajitsu/adapter-files",
      "@qajitsu/adapter-secrets-env",
    ]);
  });
});
