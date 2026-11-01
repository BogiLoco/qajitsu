#!/usr/bin/env node
// Writes packages/cli/plugins.json (REQ-GEN-11/AC3): the official plugins and the versions this QAJitsu release
// installs, read from packages/adapters/*/package.json. Run after `changeset version`; a test fails while it is stale.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The catalogue for a repository root. */
export function pluginCatalogue(root) {
  const dir = join(root, "packages", "adapters");
  const plugins = {};
  for (const id of readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()) {
    const pkg = JSON.parse(readFileSync(join(dir, id, "package.json"), "utf8"));
    plugins[id] = { package: pkg.name, version: pkg.version };
  }
  return { schema: 1, plugins };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  writeFileSync(
    join(root, "packages", "cli", "plugins.json"),
    `${JSON.stringify(pluginCatalogue(root), null, 2)}\n`,
  );
  process.stdout.write("Updated packages/cli/plugins.json\n");
}
