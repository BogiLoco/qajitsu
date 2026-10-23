import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeS3 } from "../../../../tests/support/fake-s3.js";
import { createS3Archive } from "./s3-archive.js";
import { signV4 } from "./sigv4.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const archiveOn = async (objectLock = true) => {
  const s3 = await startFakeS3({ objectLock });
  cleanups.push(s3.close);
  const archive = createS3Archive(
    { endpoint: s3.endpoint, region: "us-east-1", bucket: s3.bucket, pathStyle: true },
    { fetch: globalThis.fetch, now: () => new Date(), credentials: () => Promise.resolve(s3.credentials) },
  );
  return { s3, archive };
};

describe("S3 Object Lock archive (REQ-VER-19)", () => {
  it("REQ-VER-19/AC1: SigV4 matches the example of the AWS documentation", () => {
    // "GET Object" example of the S3 Signature V4 documentation, with AWS's published example credentials.
    const headers = signV4(
      {
        method: "GET",
        url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
        headers: { range: "bytes=0-9" },
        body: new Uint8Array(),
      },
      { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
      "us-east-1",
      new Date("2013-05-24T00:00:00Z"),
    );
    expect(headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("REQ-VER-19/AC1: an object is written with its lock and checksums, and read back with the lock the storage holds", async () => {
    const { s3, archive } = await archiveOn();
    const data = Buffer.from("evidence zip");
    const until = "2033-10-03T10:46:00.000Z";
    const put = await archive.put("qajitsu/DEMO-1/run/audit.zip", data, {
      mode: "compliance",
      retainUntil: until,
    });
    expect(put).toMatchObject({ bytes: data.length, md5: createHash("md5").update(data).digest("hex") });
    expect(await archive.head("qajitsu/DEMO-1/run/audit.zip")).toMatchObject({
      mode: "compliance",
      retainUntil: until,
      bytes: data.length,
      md5: createHash("md5").update(data).digest("hex"),
    });
    expect(await archive.head("qajitsu/DEMO-1/run/other.zip")).toBeUndefined();
    expect(archive.uri("qajitsu/DEMO-1/run/")).toBe("s3://qa-evidence/qajitsu/DEMO-1/run/");
    expect(s3.requests.every((r) => r.authorized)).toBe(true);
  });

  it("REQ-VER-19/AC1: a bucket without Object Lock, wrong credentials and unsafe keys are refused with the reason", async () => {
    const { archive } = await archiveOn(false);
    await expect(
      archive.put("k/a.zip", Buffer.from("x"), { mode: "compliance", retainUntil: "2030-01-01T00:00:00Z" }),
    ).rejects.toThrow("The archive refused k/a.zip: HTTP 400 InvalidRequest.");
    const s3 = await startFakeS3();
    cleanups.push(s3.close);
    const wrong = createS3Archive(
      { endpoint: s3.endpoint, region: "us-east-1", bucket: s3.bucket, pathStyle: true },
      {
        fetch: globalThis.fetch,
        now: () => new Date(),
        credentials: () => Promise.resolve({ accessKeyId: "TESTACCESSKEY", secretAccessKey: "wrong" }),
      },
    );
    await expect(
      wrong.put("k/a.zip", Buffer.from("x"), { mode: "compliance", retainUntil: "2030-01-01T00:00:00Z" }),
    ).rejects.toThrow("HTTP 403 SignatureDoesNotMatch");
    await expect(wrong.head("k/a.zip")).rejects.toThrow("HTTP 403");
    await expect(archive.head("../escape")).rejects.toThrow("Invalid object key");
    expect(() =>
      createS3Archive(
        { endpoint: "ftp://x", region: "r", bucket: "qa-evidence", pathStyle: true },
        {
          fetch: globalThis.fetch,
          now: () => new Date(),
          credentials: () => Promise.resolve(s3.credentials),
        },
      ),
    ).toThrow("http(s) URL");
    expect(() =>
      createS3Archive(
        { endpoint: s3.endpoint, region: "r", bucket: "Bad_Bucket", pathStyle: true },
        {
          fetch: globalThis.fetch,
          now: () => new Date(),
          credentials: () => Promise.resolve(s3.credentials),
        },
      ),
    ).toThrow("not a valid S3 bucket name");
  });

  it("REQ-VER-19/AC1: virtual-hosted addressing puts the bucket into the host name", async () => {
    const seen: string[] = [];
    const archive = createS3Archive(
      {
        endpoint: "https://s3.eu-central-1.amazonaws.com",
        region: "eu-central-1",
        bucket: "qa-evidence",
        pathStyle: false,
      },
      {
        fetch: (url) => {
          seen.push(url instanceof Request ? url.url : url.toString());
          return Promise.resolve(new Response(null, { status: 404 }));
        },
        now: () => new Date("2026-10-03T10:46:00Z"),
        credentials: () => Promise.resolve({ accessKeyId: "A", secretAccessKey: "B", sessionToken: "T" }),
      },
    );
    expect(await archive.head("p/DEMO-1/x.zip")).toBeUndefined();
    expect(seen).toEqual(["https://qa-evidence.s3.eu-central-1.amazonaws.com/p/DEMO-1/x.zip"]);
  });
});
