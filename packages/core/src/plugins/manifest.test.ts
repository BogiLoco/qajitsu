import { describe, expect, it } from "vitest";
import { PluginError } from "../errors.js";
import { PLUGIN_API_VERSION, PLUGIN_TYPES, parsePluginManifest } from "./manifest.js";

const pkg = (plugin: unknown, extra: Record<string, unknown> = {}): unknown => ({
  name: "@qajitsu/adapter-knowledge-lancedb",
  version: "1.2.3",
  ...extra,
  qajitsu: { plugin },
});

const good = {
  types: ["knowledge store"],
  core_api: "^1.0.0",
  secrets: [],
  hosts: [],
  permissions: ["filesystem"],
};

describe("plugin manifest (REQ-GEN-11)", () => {
  it("REQ-GEN-11/AC7: reads name, version, types, core API range, secrets, hosts and permissions", () => {
    expect(parsePluginManifest(pkg(good))).toEqual({
      name: "@qajitsu/adapter-knowledge-lancedb",
      version: "1.2.3",
      types: ["knowledge store"],
      coreApi: "^1.0.0",
      secrets: [],
      hosts: [],
      permissions: ["filesystem"],
    });
  });

  it("REQ-GEN-11/AC7: the plugin types are those of the inventory", () => {
    expect(PLUGIN_TYPES).toContain("ticket source");
    expect(PLUGIN_TYPES).toContain("wallet");
    expect(PLUGIN_TYPES).not.toContain("model provider");
  });

  it("REQ-GEN-11/AC7: a package without a manifest, or with an invalid one, is refused", () => {
    expect(() => parsePluginManifest({ name: "x", version: "1.0.0" })).toThrow(PluginError);
    expect(() => parsePluginManifest(pkg({ ...good, types: ["teleporter"] }))).toThrow(/types/);
    expect(() => parsePluginManifest(pkg({ ...good, types: [] }))).toThrow(PluginError);
    expect(() => parsePluginManifest(pkg({ ...good, core_api: "" }))).toThrow(PluginError);
    expect(() => parsePluginManifest(pkg({ ...good, permissions: ["root"] }))).toThrow(PluginError);
    expect(() => parsePluginManifest(pkg(good, { version: "latest" }))).toThrow(PluginError);
    expect(() => parsePluginManifest(pkg({ ...good, extra: 1 }))).toThrow(PluginError);
    try {
      parsePluginManifest(pkg({ ...good, types: ["teleporter"] }));
    } catch (error) {
      expect((error as PluginError).code).toBe("PLUGIN_MANIFEST_INVALID");
    }
  });

  it("REQ-GEN-11/AC8: the core's adapter API version is semantic", () => {
    expect(PLUGIN_API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
