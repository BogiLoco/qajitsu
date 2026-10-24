import { createHash } from "node:crypto";
import { AdapterError, type ArchivedObject, type EvidenceArchive, type RetentionMode } from "@qajitsu/core";
import { signV4, type AwsCredentials } from "./sigv4.js";

/** Configuration of an S3 Object Lock archive (`archive` in `.qa/qa.project.yaml`). */
export interface S3ArchiveConfig {
  /** Endpoint, e.g. `https://s3.eu-central-1.amazonaws.com` or a MinIO URL. */
  readonly endpoint: string;
  readonly region: string;
  /** A bucket created with Object Lock enabled. */
  readonly bucket: string;
  /** Path-style addressing (`endpoint/bucket/key`), as MinIO needs; virtual-hosted otherwise. */
  readonly pathStyle: boolean;
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const KEY = /^[A-Za-z0-9!_.*'()/-]{1,1024}$/;

/**
 * Write-once storage on S3 Object Lock (REQ-VER-19): every object is written with a retention lock (`COMPLIANCE`:
 * nobody can delete or change it before the date; `GOVERNANCE`: only with a special permission), an MD5 and SHA-256
 * checksum, and read back to confirm the lock. Signed with AWS Signature V4 on Node.js built-ins.
 *
 * @param config - Endpoint, region, bucket and addressing.
 * @param deps - Fetch, the clock and the credentials (from the secret provider).
 */
export function createS3Archive(
  config: S3ArchiveConfig,
  deps: {
    readonly fetch: typeof globalThis.fetch;
    readonly now: () => Date;
    readonly credentials: () => Promise<AwsCredentials>;
  },
): EvidenceArchive {
  if (!BUCKET.test(config.bucket))
    throw new AdapterError("ARCHIVE_CONFIG_INVALID", "The bucket name is not a valid S3 bucket name.", {});
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:")
    throw new AdapterError("ARCHIVE_CONFIG_INVALID", "The archive endpoint must be an http(s) URL.", {});
  const urlOf = (key: string): URL => {
    if (!KEY.test(key) || key.split("/").some((p) => p === ".." || p === "."))
      throw new AdapterError(
        "ARCHIVE_KEY_INVALID",
        `Invalid object key ${JSON.stringify(key.slice(0, 80))}.`,
        {},
      );
    const path = key.split("/").map(encodeURIComponent).join("/");
    return config.pathStyle
      ? new URL(`${endpoint.origin}/${config.bucket}/${path}`)
      : new URL(`${endpoint.protocol}//${config.bucket}.${endpoint.host}/${path}`);
  };
  const send = async (
    method: "PUT" | "HEAD",
    key: string,
    headers: Record<string, string>,
    body: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Response> => {
    const url = urlOf(key);
    const signed = signV4(
      { method, url, headers, body },
      await deps.credentials(),
      config.region,
      deps.now(),
    );
    return deps.fetch(url, {
      method,
      headers: signed,
      ...(method === "PUT" ? { body } : {}),
      ...(signal ? { signal } : {}),
    });
  };
  const fromHeaders = (key: string, r: Response): ArchivedObject => {
    const mode = r.headers.get("x-amz-object-lock-mode")?.toLowerCase();
    const until = r.headers.get("x-amz-object-lock-retain-until-date");
    const etag = r.headers.get("etag")?.replace(/"/g, "");
    const version = r.headers.get("x-amz-version-id");
    return {
      key,
      bytes: Number(r.headers.get("content-length") ?? "0"),
      ...(mode === "compliance" || mode === "governance" ? { mode } : {}),
      ...(until ? { retainUntil: new Date(until).toISOString() } : {}),
      ...(etag && /^[0-9a-f]{32}$/.test(etag) ? { md5: etag } : {}),
      ...(version ? { versionId: version } : {}),
    };
  };
  return {
    id: "s3-object-lock",
    uri: (prefix) => `s3://${config.bucket}/${prefix}`,
    async put(key, data, lock: { mode: RetentionMode; retainUntil: string }, signal) {
      const md5 = createHash("md5").update(data).digest();
      const r = await send(
        "PUT",
        key,
        {
          "content-type": "application/octet-stream",
          "content-md5": md5.toString("base64"),
          "x-amz-checksum-sha256": createHash("sha256").update(data).digest("base64"),
          "x-amz-object-lock-mode": lock.mode.toUpperCase(),
          "x-amz-object-lock-retain-until-date": new Date(lock.retainUntil).toISOString(),
        },
        data,
        signal,
      );
      if (!r.ok) {
        const text = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
        const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
        throw new AdapterError(
          "ARCHIVE_PUT_FAILED",
          `The archive refused ${key}: HTTP ${String(r.status)}${code ? ` ${code}` : ""}.`,
          { status: r.status },
        );
      }
      const version = r.headers.get("x-amz-version-id");
      return {
        key,
        bytes: data.byteLength,
        md5: md5.toString("hex"),
        ...(version ? { versionId: version } : {}),
      };
    },
    async head(key, signal) {
      const r = await send("HEAD", key, {}, new Uint8Array(), signal);
      if (r.status === 404) return undefined;
      if (!r.ok)
        throw new AdapterError(
          "ARCHIVE_HEAD_FAILED",
          `The archive did not show ${key}: HTTP ${String(r.status)}.`,
          {
            status: r.status,
          },
        );
      return fromHeaders(key, r);
    },
  };
}
