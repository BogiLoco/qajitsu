import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";
import { startFakeS3 } from "../../../../tests/support/fake-s3.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
type FakeS3 = Awaited<ReturnType<typeof startFakeS3>>;

/** A failed demo run whose project sends every attachment over 1 kB to the fake S3. */
const pipeline = async (s3: FakeS3 | undefined, secret?: string) => {
  const p = await createDemoPipeline({
    flag: "BUG_CART_TOTAL_ROUNDING",
    config: [
      s3
        ? `publish: { max_attachment_mb: 0.001, oversized: { type: s3, endpoint: "${s3.endpoint}", bucket: ${s3.bucket}, path_style: true, access_key_id: secret://env/QJ_FILES_KEY, secret_access_key: secret://env/QJ_FILES_SECRET, link_hours: 24 } }`
        : "publish: { max_attachment_mb: 0.001 }",
    ],
    env: s3
      ? {
          QJ_FILES_KEY: s3.credentials.accessKeyId,
          QJ_FILES_SECRET: secret ?? s3.credentials.secretAccessKey,
        }
      : {},
  });
  cleanups.push(p.cleanup);
  expect((await p.executed()).exitCode).toBe(1);
  return p;
};
/** The demo pipeline's clock: links are checked against the time they were made at. */
const PIPELINE_NOW = new Date("2026-10-03T10:46:00Z");
const fakeS3 = async () => {
  const s3 = await startFakeS3({ now: () => new Date(PIPELINE_NOW.getTime() + 60_000) });
  cleanups.push(s3.close);
  return s3;
};
const record = async (dir: string) =>
  JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as {
    data: {
      publish: {
        attachmentNames: string[];
        skipped: { name: string; reason: string }[];
        stored?: { name: string; bytes: number; sha256: string; expiresAt: string }[];
      };
    };
  };

describe("oversized attachments in object storage (REQ-PUB-02/AC3)", () => {
  it("REQ-PUB-02/AC3: after the confirmation a file over the limit is uploaded and the comment links it with its hash", async () => {
    const s3 = await fakeS3();
    const p = await pipeline(s3);
    // A declined preview uploads nothing: no file leaves the machine before a person said yes.
    const declined = await p.run(["publish", "DEMO-1"], { ask: ["n"] });
    expect(declined.out).toContain("goes to object storage (s3) and the comment links it for 24 h");
    expect(s3.requests.filter((r) => r.method === "PUT")).toHaveLength(0);

    const published = await p.run(["publish", "DEMO-1", "--auto-publish"]);
    expect(published.err).toBe("");
    expect(published.exitCode).toBe(0);
    const zipName = `DEMO-1_${p.runDir.split("/").at(-1) ?? ""}_evidence.zip`;
    expect(published.out).toContain(`stored outside the ticket: ${zipName}, link valid until`);
    // The key holds the content's hash, so a later upload never changes what an older link reads.
    const [key, versions] = [...s3.objects.entries()].find(([k]) => k.endsWith(`/${zipName}`)) ?? [];
    const object = versions?.at(-1)?.data;
    expect(object).toBeDefined();
    const sha256 = createHash("sha256")
      .update(object ?? "")
      .digest("hex");
    expect(key).toBe(
      `qajitsu/attachments/DEMO-1/${p.runDir.split("/").at(-1) ?? ""}/${sha256.slice(0, 16)}/${zipName}`,
    );

    const adf = JSON.parse(
      await readFile(join(p.runDir, "report", "published", "jira-comment.adf.json"), "utf8"),
    ) as unknown;
    const links: string[] = [];
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === "object") {
        const o = n as Record<string, unknown>;
        if (o["type"] === "link") links.push((o["attrs"] as { href: string }).href);
        Object.values(o).forEach(walk);
      }
    };
    walk(adf);
    expect(links).toHaveLength(1);
    expect(JSON.stringify(adf)).toContain(`sha256 ${sha256}`);
    expect(JSON.stringify(adf)).toContain("Stored outside the ticket (links expire)");
    // The link reads exactly the stored file; it carries the key id, never the secret.
    const read = await fetch(links[0] ?? "");
    expect(Buffer.from(await read.arrayBuffer())).toEqual(object);
    expect(new URL(links[0] ?? "").searchParams.get("X-Amz-Expires")).toBe(String(24 * 3600));
    expect(JSON.stringify(adf)).not.toContain(s3.credentials.secretAccessKey);
    // run.json and the journal name the file by hash; the signed link is only in the comment.
    const r = await record(p.runDir);
    expect(r.data.publish.stored).toEqual([
      expect.objectContaining({ name: zipName, sha256, bytes: object?.length }),
    ]);
    expect(r.data.publish.attachmentNames).not.toContain(zipName);
    expect(r.data.publish.skipped.map((s) => s.name)).not.toContain(zipName);
    const journal = await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8");
    expect(journal).toContain('"attachment.stored"');
    expect(journal).not.toContain("X-Amz-Signature");
    expect(JSON.stringify(r)).not.toContain("X-Amz-Signature");
    // INV-8: the key id is in the link (as in every S3 link) and masked everywhere else.
    expect(links[0]).toContain(s3.credentials.accessKeyId);
    expect(journal).not.toContain(s3.credentials.accessKeyId);
    expect(JSON.stringify(r)).not.toContain(s3.credentials.accessKeyId);
    expect(published.out).not.toContain(s3.credentials.accessKeyId);
  }, 240_000);

  it("REQ-PUB-02/AC3: a store that refuses the upload stops publishing; no comment links a file that is not there", async () => {
    const s3 = await fakeS3();
    const p = await pipeline(s3, "wrong-secret");
    const published = await p.run(["publish", "DEMO-1", "--auto-publish"]);
    expect(published.exitCode).toBe(3);
    expect(published.err).toContain("[ATTACHMENT_PUT_FAILED]");
    expect(published.err).toContain("HTTP 403 SignatureDoesNotMatch");
    expect(published.err).not.toContain("wrong-secret");
    expect(await readdir(join(p.runDir, "report", "published")).catch(() => [])).not.toContain(
      "jira-comment.adf.json",
    );
  }, 240_000);

  it("REQ-PUB-02/AC3: without object storage a file over the limit stays in the run folder and is listed as not attached", async () => {
    const p = await pipeline(undefined);
    const published = await p.run(["publish", "DEMO-1", "--auto-publish"]);
    expect(published.exitCode).toBe(0);
    expect(published.out).toMatch(/not attached: DEMO-1_\S+_evidence\.zip \(\d+ MB is over the 0 MB limit\)/);
    const adf = await readFile(join(p.runDir, "report", "published", "jira-comment.adf.json"), "utf8");
    expect(adf).toContain("is larger than the 0 MB limit and stays in the run folder.");
    expect((await record(p.runDir)).data.publish.stored).toBeUndefined();
  }, 240_000);
});
