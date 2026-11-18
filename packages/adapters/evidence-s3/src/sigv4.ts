import { createHash, createHmac } from "node:crypto";

/** AWS credentials, resolved from the secret provider. */
export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

const hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as SigV4 needs it (unreserved characters stay). */
const encode = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const canonicalPath = (url: URL): string =>
  url.pathname
    .split("/")
    .map((segment) => encode(decodeURIComponent(segment)))
    .join("/");
const canonicalQuery = (url: URL): string =>
  [...url.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
const signingKey = (credentials: AwsCredentials, day: string, region: string, service: string): Buffer =>
  hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), service), "aws4_request");
const amzDateOf = (now: Date): string =>
  now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/**
 * Signs an S3 request with AWS Signature Version 4 (header form): adds `host`, `x-amz-date`, `x-amz-content-sha256`
 * (and `x-amz-security-token`) and returns the headers to send with `authorization`.
 *
 * @param request - Method, URL, headers and body of the request.
 * @param credentials - Access key and secret.
 * @param region - Region of the bucket (MinIO: usually `us-east-1`).
 * @param now - Signing time.
 */
export function signV4(
  request: {
    readonly method: string;
    readonly url: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
  },
  credentials: AwsCredentials,
  region: string,
  now: Date,
  service = "s3",
): Record<string, string> {
  const amzDate = amzDateOf(now);
  const day = amzDate.slice(0, 8);
  const payload = hex(request.body);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v])),
    host: request.url.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payload,
    ...(credentials.sessionToken === undefined ? {} : { "x-amz-security-token": credentials.sessionToken }),
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names
    .map((n) => `${n}:${(headers[n] ?? "").trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");
  const canonical = [
    request.method,
    canonicalPath(request.url),
    canonicalQuery(request.url),
    canonicalHeaders,
    signedHeaders,
    payload,
  ].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(canonical)].join("\n");
  const signature = createHmac("sha256", signingKey(credentials, day, region, service))
    .update(toSign)
    .digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * A presigned link (AWS Signature Version 4, query form) that lets anyone holding it read one object until it
 * expires (REQ-PUB-02/AC3). Only `host` is signed; the access key id is part of the link, the secret never is.
 *
 * @param url - The object's URL.
 * @param credentials - Access key and secret; temporary credentials are refused, their token would be in the link.
 * @param region - Region of the bucket.
 * @param now - Signing time.
 * @param expiresInSeconds - 1 to 604800 (7 days), the most S3 accepts.
 * @returns The URL with the `X-Amz-*` query parameters.
 */
export function presignV4(
  url: URL,
  credentials: AwsCredentials,
  region: string,
  now: Date,
  expiresInSeconds: number,
  service = "s3",
): URL {
  const amzDate = amzDateOf(now);
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const signed = new URL(url);
  signed.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  signed.searchParams.set("X-Amz-Credential", `${credentials.accessKeyId}/${scope}`);
  signed.searchParams.set("X-Amz-Date", amzDate);
  signed.searchParams.set("X-Amz-Expires", String(Math.trunc(expiresInSeconds)));
  signed.searchParams.set("X-Amz-SignedHeaders", "host");
  const canonical = [
    "GET",
    canonicalPath(signed),
    canonicalQuery(signed),
    `host:${signed.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(canonical)].join("\n");
  signed.searchParams.set(
    "X-Amz-Signature",
    createHmac("sha256", signingKey(credentials, day, region, service))
      .update(toSign)
      .digest("hex"),
  );
  return signed;
}
