#!/usr/bin/env node
// REQ-GEN-15/AC2: packages are published only by the Release workflow on main of this repository, from its fresh
// checkout, never from a person's machine. `pnpm release` and every package's `prepublishOnly` run this first.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY = "BogiLoco/qajitsu";

/**
 * Why publishing is refused in this environment, or undefined when it is the Release workflow on main.
 *
 * @param {Record<string, string | undefined>} env
 */
export function publishRefusal(env) {
  if (env.GITHUB_ACTIONS !== "true")
    return "packages are published by CI only: merge the version pull request";
  if (env.GITHUB_WORKFLOW !== "Release")
    return `the ${String(env.GITHUB_WORKFLOW)} workflow does not publish; Release does`;
  if (env.GITHUB_REPOSITORY !== REPOSITORY) return `${String(env.GITHUB_REPOSITORY)} is not ${REPOSITORY}`;
  if (env.GITHUB_REF !== "refs/heads/main") return `releases come from main, not ${String(env.GITHUB_REF)}`;
  return undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const refusal = publishRefusal(process.env);
  if (refusal !== undefined) {
    process.stderr.write(`Publishing refused: ${refusal}.\n`);
    process.exitCode = 1;
  }
}
