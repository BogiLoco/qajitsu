import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { PluginError, type PluginManifest } from "@qajitsu/core";
import { checkPluginCode, pluginCodeProblems, type PluginCodeFile } from "@qajitsu/guard";

const CODE = /\.(m?js|cjs|ts)$/;

/** The plugin's own code files, without its dependencies. */
async function ownFiles(pkgDir: string): Promise<PluginCodeFile[]> {
  const out: PluginCodeFile[] = [];
  for (const entry of await readdir(pkgDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !CODE.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    const rel = relative(pkgDir, path);
    if (rel.split(/[\\/]/).includes("node_modules")) continue;
    out.push({ path: rel, text: await readFile(path, "utf8") });
  }
  return out;
}

/**
 * Refuses a plugin whose code does more than its manifest declares (REQ-GEN-11/AC9, ADR-0015): run at install and
 * again before an installed plugin is loaded, so a plugin changed on disk after its install never runs.
 *
 * @throws {PluginError} `PLUGIN_PERMISSION` naming every use its permissions do not cover.
 */
export async function assertPluginCode(id: string, pkgDir: string, manifest: PluginManifest): Promise<void> {
  const problems = pluginCodeProblems(checkPluginCode(await ownFiles(pkgDir), manifest.permissions));
  if (problems !== undefined)
    throw new PluginError(
      "PLUGIN_PERMISSION",
      `The ${id} plugin does more than its manifest declares: ${problems}. It is not used.`,
      { plugin: id },
    );
}
