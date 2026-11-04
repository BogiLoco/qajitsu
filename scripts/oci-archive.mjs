#!/usr/bin/env node
// Reads an OCI archive written by `docker buildx build --output type=oci` (REQ-GEN-09): the digest of its image index,
// which is the digest the registry gets when it is pushed with its digests preserved, and per platform the digests of
// its manifest and config. The release compares the config of the image it checked with the one it publishes.
//
//   node scripts/oci-archive.mjs <image.tar>                   prints the summary as JSON
//   node scripts/oci-archive.mjs <image.tar> <platform> <id>   fails unless <platform>'s config digest is <id>
//   node scripts/oci-archive.mjs <image.tar> --index            prints the digest the image will have when pushed

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The summary of an OCI layout, from its files.
 *
 * @param {(path: string) => string} read - Reads a file of the layout (`index.json`, `blobs/sha256/<hex>`).
 * @returns {{ index: string, platforms: Record<string, { manifest: string, config: string }> }}
 */
export function summarise(read) {
  const layout = JSON.parse(read("index.json"));
  const top = layout.manifests?.[0];
  if (layout.manifests?.length !== 1 || typeof top?.digest !== "string")
    throw new Error("the archive does not hold exactly one image");
  const blob = (digest) => JSON.parse(read(`blobs/${digest.replace(":", "/")}`));
  const index = blob(top.digest);
  if (!Array.isArray(index.manifests)) throw new Error("the archive's image is not a multi-platform index");
  const platforms = {};
  for (const m of index.manifests) {
    const p = m.platform;
    // Attestations (SBOM, provenance) are manifests of the platform unknown/unknown.
    if (!p || p.os === "unknown") continue;
    const key = `${String(p.os)}/${String(p.architecture)}${p.variant ? `/${String(p.variant)}` : ""}`;
    platforms[key] = { manifest: m.digest, config: blob(m.digest).config.digest };
  }
  return { index: top.digest, platforms };
}

/** Whether the archive's image for a platform has the config the checked image has; why not, otherwise. */
export function sameImage(summary, platform, configDigest) {
  const found = summary.platforms[platform];
  if (!found)
    return `the archive has no ${platform} image (it has ${Object.keys(summary.platforms).join(", ")})`;
  return found.config === configDigest
    ? undefined
    : `the checked ${platform} image is ${configDigest}, the archive holds ${found.config}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [archive, platform, id] = process.argv.slice(2);
  if (!archive) {
    process.stderr.write("usage: node scripts/oci-archive.mjs <image.tar> [<platform> <config digest>]\n");
    process.exitCode = 1;
  } else {
    try {
      const read = (path) => {
        const r = spawnSync("tar", ["-xOf", archive, path], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        });
        if (r.status !== 0) throw new Error(`${path} is not in ${archive}`);
        return r.stdout;
      };
      const summary = summarise(read);
      if (platform === "--index") process.stdout.write(`${summary.index}\n`);
      else if (platform !== undefined) {
        // A platform without a config digest (an `inspect` that printed nothing) is a failed check, not a summary.
        if (!id || !/^sha256:[0-9a-f]{64}$/.test(id))
          throw new Error(`no config digest given for ${platform}`);
        const problem = sameImage(summary, platform, id);
        if (problem) throw new Error(problem);
        process.stdout.write(`${platform}: the checked image is the one in the archive (${id})\n`);
      } else process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
