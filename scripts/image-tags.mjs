#!/usr/bin/env node
// Tags of the release image (REQ-GEN-09/AC4): the exact version, its minor line and `latest`; a pre-release gets its
// exact version only, so `latest` and `0.2` never move to a beta.
//
//   node scripts/image-tags.mjs <image> <version>    prints the full references, comma-separated

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The tags of a version.
 *
 * @param {string} version - e.g. `0.2.1` or `0.3.0-beta.1`.
 * @returns {string[]}
 */
export function imageTags(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(-[\w.]+)?$/.exec(version);
  if (!m) throw new Error(`${version} is not a release version`);
  if (m[4] !== undefined) return [version];
  return [version, `${m[1] ?? ""}.${m[2] ?? ""}`, "latest"];
}

/**
 * The tags added only after the image was verified: everything but the exact version, which the push itself carries.
 *
 * @param {string} version
 */
export function laterTags(version) {
  return imageTags(version).filter((t) => t !== version);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  //   node scripts/image-tags.mjs <image> <version>            all references, comma-separated
  //   node scripts/image-tags.mjs <image> <version> --later    the references added after verification, one per line
  //   node scripts/image-tags.mjs <image> <version> --bare     the tags alone, comma-separated
  const [image, version, mode] = process.argv.slice(2);
  if (!image || !version) {
    process.stderr.write("usage: node scripts/image-tags.mjs <image> <version> [--later | --bare]\n");
    process.exitCode = 1;
  } else if (mode === "--bare") process.stdout.write(`${imageTags(version).join(",")}\n`);
  else if (mode === "--later")
    process.stdout.write(
      laterTags(version)
        .map((t) => `${image}:${t}\n`)
        .join(""),
    );
  else
    process.stdout.write(
      `${imageTags(version)
        .map((t) => `${image}:${t}`)
        .join(",")}\n`,
    );
}
