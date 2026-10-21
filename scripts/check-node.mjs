#!/usr/bin/env node
// Part of `pnpm verify` (REQ-NFR-10/AC3): CI runs the Node.js major of `.nvmrc`. A different major on this machine
// can hide failures that only that version shows (Node 22 printed a proxy warning into sandboxed tool output that
// Node 26 does not), so verify says so before it starts. A warning, not a failure: newer Node is allowed to work.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * The warning for a Node.js version that is not the one CI uses, or nothing.
 *
 * @param {string} running - `process.version`, e.g. `v26.0.0`.
 * @param {string} wanted - Contents of `.nvmrc`, e.g. `22`.
 * @returns {string | undefined}
 */
export function nodeVersionWarning(running, wanted) {
  const want = wanted.trim().replace(/^v/, "").split(".")[0] ?? "";
  const have = running.replace(/^v/, "").split(".")[0] ?? "";
  if (want === "" || want === have) return undefined;
  return `Warning: Node.js ${running} runs this check, CI uses Node.js ${want} (.nvmrc). Failures that only Node.js ${want} shows stay hidden here; switch with 'nvm use' or 'fnm use' before relying on a green verify.\n`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const warning = nodeVersionWarning(
    process.version,
    readFileSync(new URL("../.nvmrc", import.meta.url), "utf8"),
  );
  if (warning) process.stderr.write(warning);
}
