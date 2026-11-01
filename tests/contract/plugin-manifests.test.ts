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
});
