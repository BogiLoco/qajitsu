import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PluginError } from "@qajitsu/core";
import { z } from "zod";

const PluginId = z.string().regex(/^[a-z][a-z0-9-]*$/);

const CatalogueSchema = z.strictObject({
  schema: z.literal(1),
  plugins: z.record(
    PluginId,
    z.strictObject({ package: z.string().min(1), version: z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/) }),
  ),
});

/** The official plugins and the version this release installs of each (REQ-GEN-11/AC3), from `plugins.json`. */
export type PluginCatalogue = z.infer<typeof CatalogueSchema>;

/** One official plugin of the catalogue. */
export interface CatalogueEntry {
  readonly id: string;
  readonly package: string;
  readonly version: string;
}

/**
 * Reads the plugin catalogue shipped with the CLI (`packages/cli/plugins.json`, written by
 * `pnpm plugins:catalogue`): versions are pinned per QAJitsu release.
 *
 * @param file - The catalogue file (replaced in tests).
 */
export function readCatalogue(
  file: string = fileURLToPath(new URL("../../plugins.json", import.meta.url)),
): PluginCatalogue {
  return CatalogueSchema.parse(JSON.parse(readFileSync(file, "utf8")) as unknown);
}

/**
 * The catalogue entry of a plugin, by id (`knowledge-lancedb`) or package name.
 *
 * @throws {PluginError} `PLUGIN_UNKNOWN` with the official plugins listed.
 */
export function catalogueEntry(catalogue: PluginCatalogue, idOrPackage: string): CatalogueEntry {
  for (const [id, p] of Object.entries(catalogue.plugins))
    if (id === idOrPackage || p.package === idOrPackage)
      return { id, package: p.package, version: p.version };
  throw new PluginError(
    "PLUGIN_UNKNOWN",
    `No official plugin "${idOrPackage}". Official plugins: ${Object.keys(catalogue.plugins).join(", ")}.`,
    { plugin: idOrPackage },
  );
}

/** The command that installs a plugin, as every message about a missing plugin names it (REQ-GEN-11/AC2). */
export const installCommand = (id: string): string => `qj plugin add ${id}`;
