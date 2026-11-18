import { createHash } from "node:crypto";
import { AdapterError, type AttachmentStore } from "@qajitsu/core";
import { presignV4, signV4, type AwsCredentials } from "./sigv4.js";

/** Configuration of the S3 store for oversized attachments (`publish.oversized` with `type: s3`). */
export interface S3AttachmentStoreConfig {
  /** Endpoint, e.g. `https://s3.eu-central-1.amazonaws.com` or a MinIO URL. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  /** Path-style addressing (`endpoint/bucket/key`), as MinIO needs; virtual-hosted otherwise. */
  readonly pathStyle: boolean;
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const KEY = /^[A-Za-z0-9!_.*'()/-]{1,1024}$/;
/** The longest a presigned link may last (7 days). */
const MAX_EXPIRES_S = 604_800;

/**
 * Oversized attachments on S3 (REQ-PUB-02/AC3): AWS, MinIO and other S3-compatible stores. The file is uploaded with
 * its MD5 and the link is presigned for reading that one object until it expires. Signed with AWS Signature V4 on
 * Node.js built-ins.
 *
 * @param config - Endpoint, region, bucket and addressing.
 * @param deps - Fetch, the clock and the credentials (from the secret provider).
 * @example
 * const store = createS3AttachmentStore(
 *   { endpoint: "https://s3.eu-central-1.amazonaws.com", region: "eu-central-1", bucket: "qa", pathStyle: false },
 *   { fetch, now: () => new Date(), credentials },
 * );
 * const { url } = await store.put("qajitsu/attachments/SHOP-1/run/video.webm", data, { mimeType: "video/webm", expiresInSeconds: 86_400 });
 */
export function createS3AttachmentStore(
  config: S3AttachmentStoreConfig,
  deps: {
    readonly fetch: typeof globalThis.fetch;
    readonly now: () => Date;
    readonly credentials: () => Promise<AwsCredentials>;
  },
): AttachmentStore {
  if (!BUCKET.test(config.bucket))
    throw new AdapterError(
      "ATTACHMENT_STORE_CONFIG_INVALID",
      "The bucket name is not a valid S3 bucket name.",
      {},
    );
  const endpoint = new URL(config.endpoint);
  // Links work for days and go into tickets: plain http only to this machine.
  const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback))
    throw new AdapterError(
      "ATTACHMENT_STORE_CONFIG_INVALID",
      "The S3 endpoint must be an https URL (plain http only on localhost).",
      {},
    );
  const urlOf = (key: string): URL => {
    if (!KEY.test(key) || key.split("/").some((p) => p === ".." || p === "." || p === ""))
      throw new AdapterError(
        "ATTACHMENT_KEY_INVALID",
        `Invalid object key ${JSON.stringify(key.slice(0, 80))}.`,
        {},
      );
    const path = key.split("/").map(encodeURIComponent).join("/");
    return config.pathStyle
      ? new URL(`${endpoint.origin}/${config.bucket}/${path}`)
      : new URL(`${endpoint.protocol}//${config.bucket}.${endpoint.host}/${path}`);
  };
  return {
    id: "s3",
    async put(key, data, options, signal) {
      if (
        !Number.isInteger(options.expiresInSeconds) ||
        options.expiresInSeconds < 1 ||
        options.expiresInSeconds > MAX_EXPIRES_S
      )
        throw new AdapterError("ATTACHMENT_LINK_INVALID", "An S3 link lasts from 1 second to 7 days.", {});
      const credentials = await deps.credentials();
      if (credentials.sessionToken !== undefined)
        throw new AdapterError(
          "ATTACHMENT_STORE_CONFIG_INVALID",
          "Temporary credentials would put their session token into every link; use a key of its own.",
          {},
        );
      const url = urlOf(key);
      const now = deps.now();
      const headers = signV4(
        {
          method: "PUT",
          url,
          headers: {
            "content-type": options.mimeType,
            "content-md5": createHash("md5").update(data).digest("base64"),
            "x-amz-checksum-sha256": createHash("sha256").update(data).digest("base64"),
          },
          body: data,
        },
        credentials,
        config.region,
        now,
      );
      // The redirect of a misconfigured endpoint is no upload; an answer's text is never quoted back.
      const r = await deps.fetch(url, {
        method: "PUT",
        headers,
        body: data,
        redirect: "error",
        ...(signal ? { signal } : {}),
      });
      if (!r.ok) {
        const code = /<Code>([A-Za-z]{1,64})<\/Code>/.exec(await r.text().catch(() => ""))?.[1];
        throw new AdapterError(
          "ATTACHMENT_PUT_FAILED",
          `The S3 store refused ${key}: HTTP ${String(r.status)}${code ? ` ${code}` : ""}.`,
          { status: r.status },
        );
      }
      return {
        key,
        url: presignV4(url, credentials, config.region, now, options.expiresInSeconds).toString(),
        expiresAt: new Date(now.getTime() + options.expiresInSeconds * 1000).toISOString(),
        bytes: data.byteLength,
      };
    },
  };
}
