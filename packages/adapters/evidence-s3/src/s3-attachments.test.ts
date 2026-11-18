import { AdapterError } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeS3 } from "../../../../tests/support/fake-s3.js";
import { createS3AttachmentStore } from "./s3-attachments.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});
const setup = async (credentials?: {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}) => {
  const s3 = await startFakeS3();
  closers.push(s3.close);
  const store = createS3AttachmentStore(
    { endpoint: s3.endpoint, region: "us-east-1", bucket: s3.bucket, pathStyle: true },
    {
      fetch: globalThis.fetch,
      now: () => new Date(),
      credentials: () => Promise.resolve(credentials ?? s3.credentials),
    },
  );
  return { s3, store };
};

describe("S3 store for oversized attachments (REQ-PUB-02/AC3)", () => {
  it("REQ-PUB-02/AC3: uploads the file and returns a link that reads it until it expires", async () => {
    const { s3, store } = await setup();
    const data = Buffer.from("a long video");
    const stored = await store.put("qajitsu/attachments/DEMO-1/run/TC-01_video.webm", data, {
      mimeType: "video/webm",
      expiresInSeconds: 3600,
    });
    expect(s3.objects.get("qajitsu/attachments/DEMO-1/run/TC-01_video.webm")?.at(-1)?.data).toEqual(data);
    expect(stored).toMatchObject({
      key: "qajitsu/attachments/DEMO-1/run/TC-01_video.webm",
      bytes: data.length,
    });
    expect(Date.parse(stored.expiresAt) - Date.now()).toBeGreaterThan(3500_000);
    const url = new URL(stored.url);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    // The link carries the key id, never the secret.
    expect(stored.url).toContain(s3.credentials.accessKeyId);
    expect(stored.url).not.toContain(s3.credentials.secretAccessKey);
    const read = await fetch(stored.url);
    expect(read.status).toBe(200);
    expect(Buffer.from(await read.arrayBuffer())).toEqual(data);
    // A link whose signature was changed reads nothing.
    url.searchParams.set("X-Amz-Expires", "604800");
    expect((await fetch(url)).status).toBe(403);
  });

  it("REQ-PUB-02/AC3 + INV-8: temporary credentials, a link over 7 days and an unsafe key are refused before upload", async () => {
    const { s3, store } = await setup();
    const put = (key: string, expiresInSeconds = 60) =>
      store.put(key, Buffer.from("x"), { mimeType: "image/png", expiresInSeconds }).catch((e: unknown) => e);
    expect(((await put("a/b.png", 604_801)) as AdapterError).code).toBe("ATTACHMENT_LINK_INVALID");
    expect(((await put("a/b.png", 0)) as AdapterError).code).toBe("ATTACHMENT_LINK_INVALID");
    for (const key of ["a/../b.png", "a//b.png", "a/b c.png", ""])
      expect(((await put(key)) as AdapterError).code, key).toBe("ATTACHMENT_KEY_INVALID");
    const temporary = (await setup({ ...s3.credentials, sessionToken: "fictional-session" })).store;
    const refused = await temporary
      .put("a/b.png", Buffer.from("x"), { mimeType: "image/png", expiresInSeconds: 60 })
      .catch((e: unknown) => e);
    expect((refused as AdapterError).code).toBe("ATTACHMENT_STORE_CONFIG_INVALID");
    expect((refused as Error).message).not.toContain("fictional-session");
    expect(s3.requests).toHaveLength(0);
  });

  it("REQ-PUB-02/AC3: a refused upload is an error with the storage's code, never a link", async () => {
    const { s3 } = await setup();
    const wrong = createS3AttachmentStore(
      { endpoint: s3.endpoint, region: "us-east-1", bucket: s3.bucket, pathStyle: true },
      {
        fetch: globalThis.fetch,
        now: () => new Date(),
        credentials: () =>
          Promise.resolve({ accessKeyId: s3.credentials.accessKeyId, secretAccessKey: "wrong-secret" }),
      },
    );
    const error = await wrong
      .put("a/b.png", Buffer.from("x"), { mimeType: "image/png", expiresInSeconds: 60 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as Error).message).toBe("The S3 store refused a/b.png: HTTP 403 SignatureDoesNotMatch.");
    expect(() =>
      createS3AttachmentStore(
        { endpoint: "ftp://x", region: "us-east-1", bucket: "qa-files", pathStyle: true },
        {
          fetch: globalThis.fetch,
          now: () => new Date(),
          credentials: () => Promise.resolve(s3.credentials),
        },
      ),
    ).toThrow("https");
    // Links work for days: plain http to another machine is refused, to this one allowed (a lab MinIO).
    expect(() =>
      createS3AttachmentStore(
        {
          endpoint: "http://minio.example.test:9000",
          region: "us-east-1",
          bucket: "qa-files",
          pathStyle: true,
        },
        {
          fetch: globalThis.fetch,
          now: () => new Date(),
          credentials: () => Promise.resolve(s3.credentials),
        },
      ),
    ).toThrow("plain http only on localhost");
    expect(() =>
      createS3AttachmentStore(
        { endpoint: s3.endpoint, region: "us-east-1", bucket: "Bad_Bucket", pathStyle: true },
        {
          fetch: globalThis.fetch,
          now: () => new Date(),
          credentials: () => Promise.resolve(s3.credentials),
        },
      ),
    ).toThrow("bucket");
  });

  it("REQ-PUB-02/AC3: virtual-hosted addressing puts the bucket in the host", async () => {
    let seen: URL | undefined;
    const store = createS3AttachmentStore(
      {
        endpoint: "https://s3.eu-central-1.amazonaws.com",
        region: "eu-central-1",
        bucket: "qa-files",
        pathStyle: false,
      },
      {
        fetch: ((url: URL, init: RequestInit) => {
          seen = url;
          expect(init.redirect).toBe("error");
          return Promise.resolve(new Response(null, { status: 200 }));
        }) as unknown as typeof fetch,
        now: () => new Date("2026-11-18T10:00:00Z"),
        credentials: () => Promise.resolve({ accessKeyId: "AKIDFICTIONAL", secretAccessKey: "fictional" }),
      },
    );
    const stored = await store.put("p/x.zip", Buffer.from("z"), {
      mimeType: "application/zip",
      expiresInSeconds: 86_400,
    });
    expect(seen?.host).toBe("qa-files.s3.eu-central-1.amazonaws.com");
    expect(new URL(stored.url).searchParams.get("X-Amz-Credential")).toBe(
      "AKIDFICTIONAL/20261118/eu-central-1/s3/aws4_request",
    );
    expect(stored.expiresAt).toBe("2026-11-19T10:00:00.000Z");
  });
});
