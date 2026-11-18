import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { presignV4, signV4 } from "../../packages/adapters/evidence-s3/src/sigv4.js";

/** An object the fake S3 holds, with its lock. */
export interface FakeS3Object {
  readonly data: Buffer;
  readonly mode?: string;
  readonly retainUntil?: string;
  readonly versionId: string;
}

/** Whether a presigned link is signed with the credentials and has not expired. */
function presignedValid(
  url: URL,
  credentials: { accessKeyId: string; secretAccessKey: string },
  now: number,
): boolean {
  const date = url.searchParams.get("X-Amz-Date") ?? "";
  const at = new Date(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
  );
  const expires = Number(url.searchParams.get("X-Amz-Expires"));
  const unsigned = new URL(url);
  for (const k of [...unsigned.searchParams.keys()])
    if (k.startsWith("X-Amz-")) unsigned.searchParams.delete(k);
  const again = presignV4(unsigned, credentials, "us-east-1", at, expires);
  return (
    again.searchParams.get("X-Amz-Signature") === url.searchParams.get("X-Amz-Signature") &&
    now <= at.getTime() + expires * 1000
  );
}

/**
 * A fake S3 with Object Lock on localhost (path-style): checks the SigV4 signature of every request with the test
 * credentials, needs `Content-MD5` on a locked PUT, keeps every version of an object, and refuses deletes of locked
 * versions. `objectLock: false` behaves like a bucket created without Object Lock.
 */
export async function startFakeS3(
  options: {
    readonly objectLock?: boolean;
    readonly bucket?: string;
    readonly ignoreLock?: boolean;
    /** The clock a presigned link's expiry is checked against. */
    readonly now?: () => Date;
  } = {},
) {
  const credentials = { accessKeyId: "TESTACCESSKEY", secretAccessKey: "fictional-test-secret" };
  const bucket = options.bucket ?? "qa-evidence";
  const objects = new Map<string, FakeS3Object[]>();
  const requests: { method: string; path: string; authorized: boolean }[] = [];
  let version = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", (): void => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? ""}`);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers))
        if (typeof v === "string" && k !== "authorization" && k !== "connection" && k !== "content-length")
          headers[k] = v;
      const auth = req.headers.authorization ?? "";
      const signedNames = /SignedHeaders=([^,]+)/.exec(auth)?.[1]?.split(";") ?? [];
      const signedHeaders = Object.fromEntries(signedNames.map((n) => [n, headers[n] ?? ""]));
      const date = headers["x-amz-date"] ?? "";
      const at = new Date(
        `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
      );

      // A presigned GET carries its signature in the query (REQ-PUB-02/AC3): checked the same way, and its expiry.
      const presigned = req.method === "GET" && url.searchParams.has("X-Amz-Signature");
      const expected = (): string | undefined =>
        signV4({ method: req.method ?? "", url, headers: signedHeaders, body }, credentials, "us-east-1", at)[
          "authorization"
        ];
      const authorized = presigned
        ? presignedValid(url, credentials, (options.now ?? (() => new Date()))().getTime())
        : expected() === auth;
      requests.push({ method: req.method ?? "", path: url.pathname, authorized });
      const fail = (status: number, code: string): void => {
        res
          .writeHead(status, { "content-type": "application/xml" })
          .end(`<Error><Code>${code}</Code></Error>`);
      };
      if (!authorized) {
        fail(403, "SignatureDoesNotMatch");
        return;
      }
      const [, b, ...rest] = url.pathname.split("/");
      const key = rest.map(decodeURIComponent).join("/");
      if (b !== bucket) {
        fail(404, "NoSuchBucket");
        return;
      }
      if (req.method === "PUT") {
        const mode = headers["x-amz-object-lock-mode"];
        if (mode !== undefined && options.objectLock === false) {
          fail(400, "InvalidRequest");
          return;
        }
        const md5 = createHash("md5").update(body).digest("base64");
        if (mode !== undefined && headers["content-md5"] !== md5) {
          fail(400, "BadDigest");
          return;
        }
        if (headers["x-amz-checksum-sha256"] !== createHash("sha256").update(body).digest("base64")) {
          fail(400, "BadDigest");
          return;
        }
        version += 1;
        const entry: FakeS3Object = {
          data: body,
          ...(mode === undefined || options.ignoreLock === true
            ? {}
            : { mode, retainUntil: headers["x-amz-object-lock-retain-until-date"] }),
          versionId: `v${String(version)}`,
        };
        objects.set(key, [...(objects.get(key) ?? []), entry]);
        res
          .writeHead(200, {
            etag: `"${createHash("md5").update(body).digest("hex")}"`,
            "x-amz-version-id": entry.versionId,
          })
          .end();
        return;
      }
      if (req.method === "GET" && presigned) {
        const latest = objects.get(key)?.at(-1);
        if (!latest) {
          fail(404, "NoSuchKey");
          return;
        }
        res.writeHead(200, { "content-length": String(latest.data.length) }).end(latest.data);
        return;
      }
      if (req.method === "HEAD") {
        const latest = objects.get(key)?.at(-1);
        if (!latest) {
          res.writeHead(404).end();
          return;
        }
        res
          .writeHead(200, {
            "content-length": String(latest.data.length),
            etag: `"${createHash("md5").update(latest.data).digest("hex")}"`,
            "x-amz-version-id": latest.versionId,
            ...(latest.mode
              ? {
                  "x-amz-object-lock-mode": latest.mode,
                  "x-amz-object-lock-retain-until-date": latest.retainUntil ?? "",
                }
              : {}),
          })
          .end();
        return;
      }
      fail(405, "MethodNotAllowed");
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    endpoint: `http://127.0.0.1:${String(port)}`,
    bucket,
    credentials,
    objects,
    requests,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => {
          done();
        });
      }),
  };
}
