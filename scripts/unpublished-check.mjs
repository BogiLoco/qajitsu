#!/usr/bin/env node
// REQ-GEN-15/AC2 + REQ-GEN-09: decides, before publishing, whether this run publishes the release. `pnpm -r publish`
// silently skips a version that is already in the registry; the release (and its image, built from the registry) would
// then carry a tarball someone else published, e.g. with a leaked token. So:
// - no package of the release is in the registry at its version: publish;
// - all of them are, and the CLI's release tag exists: this release is done, nothing to publish;
// - anything else (some published, all published without the tag, the registry not answering): refuse. A release that
//   stopped half-way is finished by hand after checking the provenance of what is there (docs/releasing.md).
//
//   node scripts/unpublished-check.mjs    prints the decision; writes publish=true|false to GITHUB_OUTPUT; fails on refuse

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishablePackages } from "./release-check.mjs";

/**
 * Whether this run publishes the release.
 *
 * @param {{ name: string, version: string }[]} packages - The release's packages at their new versions.
 * @param {(spec: string) => "published" | "absent" | "unknown"} lookup - Asks the registry about `name@version`.
 * @param {(tag: string) => boolean} tagExists - Whether the git tag exists.
 * @returns {{ action: "publish" | "done" | "refuse", reason: string }}
 */
export function releaseDecision(packages, lookup, tagExists) {
  if (packages.length === 0) return { action: "refuse", reason: "the release has no packages" };
  const published = [];
  const unknown = [];
  for (const p of packages) {
    const spec = `${p.name}@${p.version}`;
    const answer = lookup(spec);
    if (answer === "published") published.push(spec);
    else if (answer !== "absent") unknown.push(spec);
  }
  if (unknown.length > 0)
    return { action: "refuse", reason: `the registry did not answer for ${unknown.join(", ")}` };
  if (published.length === 0)
    return {
      action: "publish",
      reason: `${String(packages.length)} packages, none of them in the registry yet`,
    };
  if (published.length < packages.length)
    return {
      action: "refuse",
      reason: `already in the registry, though the rest of the release is not: ${published.join(", ")}`,
    };
  const cli = packages.find((p) => p.name === "@qajitsu/cli");
  const tag = cli ? `${cli.name}@${cli.version}` : undefined;
  if (tag && tagExists(tag))
    return { action: "done", reason: `${tag} is released and tagged; nothing to publish` };
  return {
    action: "refuse",
    reason: `every package is in the registry, but ${tag ?? "the CLI"} was never tagged by a release run`,
  };
}

/** What `npm view <spec> version` says: published, absent (E404), or unknown (any other failure). */
function npmLookup(spec) {
  const r = spawnSync("npm", ["view", spec, "version", "--json"], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.trim() === "" ? "absent" : "published";
  return /E404|404 Not Found/.test(`${r.stdout}${r.stderr}`) ? "absent" : "unknown";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const packages = publishablePackages(root).map((p) => ({
    name: p.manifest.name,
    version: p.manifest.version,
  }));
  const tagExists = (tag) =>
    spawnSync("git", ["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`], { cwd: root }).status === 0;
  const decision = releaseDecision(packages, npmLookup, tagExists);
  if (decision.action === "refuse") {
    process.stderr.write(`Publishing refused: ${decision.reason}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `${decision.action === "publish" ? "Publishing" : "Nothing to publish"}: ${decision.reason}\n`,
    );
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `publish=${String(decision.action === "publish")}\n`);
  }
}
