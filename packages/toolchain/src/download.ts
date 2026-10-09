import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { AdapterError } from "@qajitsu/core";
import type { Checksum } from "./manifest.js";
import type { RunExec } from "./network.js";

/** Hashes a file with the algorithm of a published checksum. */
export async function hashFile(file: string, algorithm: Checksum["algorithm"]): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** A file to download. */
export interface DownloadRequest {
  readonly url: string;
  readonly checksum: Checksum;
  /** Where the verified file ends up. */
  readonly dest: string;
}

/**
 * Downloads a file with curl (REQ-GEN-06/AC6): resumed from a partial `.part` file, verified against the published
 * checksum before it is used, and renamed into place only when it matches. A file already at `dest` that matches is
 * reused (an earlier run or `--download`). A mismatch deletes the partial file and fails; the archive is never used.
 *
 * @param request - URL, checksum and destination.
 * @param exec - Runs curl.
 * @param curlArgs - Proxy and CA arguments.
 * @returns `dest`.
 * @throws {AdapterError} `DOWNLOAD_FAILED` or `CHECKSUM_MISMATCH`.
 */
export async function downloadVerified(
  request: DownloadRequest,
  exec: RunExec,
  curlArgs: readonly string[] = [],
): Promise<string> {
  const { url, checksum, dest } = request;
  const exists = async (file: string): Promise<boolean> =>
    (await stat(file).catch(() => undefined))?.isFile() === true;
  if ((await exists(dest)) && (await hashFile(dest, checksum.algorithm)) === checksum.value) return dest;
  await mkdir(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const result = await exec("curl", [
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "--retry",
    "3",
    "--retry-delay",
    "2",
    "--connect-timeout",
    "30",
    "--continue-at",
    "-",
    ...curlArgs,
    "--output",
    part,
    url,
  ]);
  // A finished .part makes curl fail its range request; the checksum decides either way.
  if (!(await exists(part)))
    throw new AdapterError(
      "DOWNLOAD_FAILED",
      `Download of ${url} failed: ${result.stderr.trim().slice(-300)}`,
      {
        url,
      },
    );
  const actual = await hashFile(part, checksum.algorithm);
  if (actual !== checksum.value) {
    if (result.code !== 0)
      throw new AdapterError(
        "DOWNLOAD_FAILED",
        `Download of ${url} stopped (${result.stderr.trim().slice(-300)}); run qj setup again to resume it.`,
        { url },
      );
    await rm(part, { force: true });
    throw new AdapterError(
      "CHECKSUM_MISMATCH",
      `${url} does not match its published ${checksum.algorithm} checksum (expected ${checksum.value}, got ${actual}); the file was deleted and not used.`,
      { url },
    );
  }
  await rename(part, dest);
  return dest;
}
