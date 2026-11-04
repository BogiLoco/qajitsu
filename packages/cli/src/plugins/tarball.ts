import { gunzipSync } from "node:zlib";
import { PluginError } from "@qajitsu/core";

const BLOCK = 512;
const MAX_UNPACKED = 512 * 1024 * 1024;

const text = (data: Uint8Array, start: number, length: number): string => {
  const slice = data.subarray(start, start + length);
  const end = slice.indexOf(0);
  return Buffer.from(end === -1 ? slice : slice.subarray(0, end)).toString("utf8");
};

/**
 * The `package.json` of an npm tarball (`package/package.json`), read without unpacking anything to disk, so a
 * plugin's manifest is checked before npm installs it (REQ-GEN-11/AC7, AC8).
 *
 * @param tgz - The gzipped tarball.
 * @returns The parsed `package.json`.
 * @throws {PluginError} `PLUGIN_WRONG_PACKAGE` when it is not a gzipped tarball with one top-level `package.json`.
 */
export function packageJsonFromTarball(tgz: Uint8Array): unknown {
  let tar: Uint8Array;
  try {
    tar = gunzipSync(tgz, { maxOutputLength: MAX_UNPACKED });
  } catch {
    throw new PluginError("PLUGIN_WRONG_PACKAGE", "The plugin is not a gzipped npm tarball.", {});
  }
  for (let at = 0; at + BLOCK <= tar.length;) {
    const name = text(tar, at, 100);
    if (name === "") break;
    const size = Number.parseInt(text(tar, at + 124, 12).trim() || "0", 8);
    const type = text(tar, at + 156, 1);
    const prefix = text(tar, at + 345, 155);
    const path = prefix === "" ? name : `${prefix}/${name}`;
    const body = at + BLOCK;
    if (!Number.isFinite(size) || size < 0 || body + size > tar.length) break;
    if ((type === "" || type === "0") && /^[^/]+\/package\.json$/.test(path)) {
      try {
        return JSON.parse(Buffer.from(tar.subarray(body, body + size)).toString("utf8")) as unknown;
      } catch {
        break;
      }
    }
    at = body + Math.ceil(size / BLOCK) * BLOCK;
  }
  throw new PluginError("PLUGIN_WRONG_PACKAGE", "The tarball has no package.json at its top level.", {});
}
