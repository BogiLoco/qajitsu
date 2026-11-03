import { createHash } from "node:crypto";
import type { EvidenceArchive } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeS3 } from "../support/fake-s3.js";

/** Where the archive under test stores: a fake S3 with Object Lock on localhost. */
export interface ArchiveTarget {
  readonly endpoint: string;
  readonly bucket: string;
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string };
}

/**
 * Contract of an {@link EvidenceArchive} (REQ-VER-19, REQ-GEN-11/AC11): an object is written with its lock and read
 * back with the lock the storage holds, a missing object is undefined, and storage that cannot lock is refused.
 *
 * @param name - The archive under test.
 * @param create - Builds the archive for a target.
 */
export function evidenceArchiveContract(
  name: string,
  create: (target: ArchiveTarget) => Promise<EvidenceArchive>,
): void {
  describe(`EvidenceArchive contract: ${name}`, () => {
    const cleanups: (() => Promise<void>)[] = [];
    afterEach(async () => {
      for (const c of cleanups.splice(0)) await c();
    });
    const target = async (objectLock = true) => {
      const s3 = await startFakeS3({ objectLock });
      cleanups.push(s3.close);
      return s3;
    };

    it("REQ-VER-19/AC1: writes an object with its lock and reads back the lock the storage holds", async () => {
      const archive = await create(await target());
      const data = Buffer.from("evidence zip");
      const until = "2033-10-03T10:46:00.000Z";
      await archive.put("qajitsu/DEMO-1/run/audit.zip", data, { mode: "compliance", retainUntil: until });
      expect(await archive.head("qajitsu/DEMO-1/run/audit.zip")).toMatchObject({
        mode: "compliance",
        retainUntil: until,
        bytes: data.length,
        md5: createHash("md5").update(data).digest("hex"),
      });
      expect(await archive.head("qajitsu/DEMO-1/run/other.zip")).toBeUndefined();
    });

    it("REQ-VER-19/AC1: storage that cannot lock objects is refused, never written as if locked", async () => {
      const archive = await create(await target(false));
      await expect(
        archive.put("qajitsu/DEMO-1/run/audit.zip", Buffer.from("x"), {
          mode: "compliance",
          retainUntil: "2033-10-03T10:46:00.000Z",
        }),
      ).rejects.toThrow();
    });
  });
}
