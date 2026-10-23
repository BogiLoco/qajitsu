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
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
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
  const path = request.url.pathname
    .split("/")
    .map((segment) => encode(decodeURIComponent(segment)))
    .join("/");
  const query = [...request.url.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [request.method, path, query, canonicalHeaders, signedHeaders, payload].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(canonical)].join("\n");
  const key = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), service),
    "aws4_request",
  );
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
