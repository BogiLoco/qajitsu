import { z } from "zod";
import { PluginError } from "../errors.js";

/**
 * Version of the adapter API of `@qajitsu/core` that plugins implement (REQ-GEN-11/AC8, REQ-GEN-12/AC8): a breaking
 * change to an adapter interface raises the major version, a plugin states the range it works with.
 */
export const PLUGIN_API_VERSION = "1.0.0";

/**
 * Plugin types (REQ-GEN-11/AC7), those of the plugin inventory (`docs/architecture/plugins.md`, REQ-GEN-14). Model
 * providers and embedders stay in the core; telemetry and pipelines are not loaded by QAJitsu.
 */
export const PLUGIN_TYPES = [
  "ticket source",
  "ticket workflow",
  "bug tracker",
  "test-case source",
  "publisher",
  "code host",
  "runner",
  "environment provider",
  "device provider",
  "secret provider",
  "evidence store",
  "evidence archive",
  "knowledge store",
  "document source",
  "message capture",
  "test data",
  "mock server",
  "tool",
  "chain",
  "wallet",
] as const;

/** One plugin type. */
export type PluginType = (typeof PLUGIN_TYPES)[number];

/** What a plugin may do besides implementing its interfaces: reach the network, start processes, write files. */
export const PLUGIN_PERMISSIONS = ["network", "exec", "filesystem"] as const;

const ManifestBlockSchema = z.strictObject({
  types: z.array(z.enum(PLUGIN_TYPES)).min(1),
  /** Range of {@link PLUGIN_API_VERSION} the plugin works with, e.g. `^1.0.0`. */
  core_api: z.string().min(1).max(100),
  /** What it needs from the secret provider, by name (an API token, a client secret). */
  secrets: z.array(z.string().min(1).max(200)).max(50).default([]),
  /** Hosts it connects to; `config` stands for the URL the project configures. */
  hosts: z.array(z.string().min(1).max(200)).max(50).default([]),
  permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).default([]),
});

const PackageSchema = z.object({
  name: z.string().regex(/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/, "an npm package name"),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/, "a semantic version"),
  qajitsu: z.object({ plugin: ManifestBlockSchema }),
});

/** A plugin's manifest (REQ-GEN-11/AC7), kept in its `package.json` under `qajitsu.plugin`. */
export interface PluginManifest {
  readonly name: string;
  readonly version: string;
  readonly types: readonly PluginType[];
  readonly coreApi: string;
  readonly secrets: readonly string[];
  readonly hosts: readonly string[];
  readonly permissions: readonly (typeof PLUGIN_PERMISSIONS)[number][];
}

/**
 * Reads a plugin's manifest from its `package.json` (REQ-GEN-11/AC7).
 *
 * @param packageJson - The parsed `package.json` of the plugin package.
 * @returns The manifest.
 * @throws {PluginError} `PLUGIN_MANIFEST_INVALID` when the package has no valid `qajitsu.plugin` block.
 */
export function parsePluginManifest(packageJson: unknown): PluginManifest {
  const parsed = PackageSchema.safeParse(packageJson);
  if (!parsed.success) {
    const name =
      packageJson !== null && typeof packageJson === "object" && "name" in packageJson
        ? String(packageJson.name)
        : "package";
    throw new PluginError(
      "PLUGIN_MANIFEST_INVALID",
      `${name} has no valid plugin manifest (qajitsu.plugin in package.json): ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
      { name },
    );
  }
  const { name, version, qajitsu } = parsed.data;
  const block = qajitsu.plugin;
  return {
    name,
    version,
    types: block.types,
    coreApi: block.core_api,
    secrets: block.secrets,
    hosts: block.hosts,
    permissions: block.permissions,
  };
}
