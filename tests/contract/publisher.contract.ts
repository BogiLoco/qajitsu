import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunIdSchema, TicketKeySchema, type PublishInput, type Publisher } from "@qajitsu/core";
import { describe, expect, it } from "vitest";

/** Two small attachments on disk and a comment, as `qj publish` hands them over. */
const publishInput = async (previous?: PublishInput["previous"]): Promise<PublishInput> => {
  const dir = await mkdtemp(join(tmpdir(), "qj-pub-contract-"));
  await writeFile(join(dir, "evidence.zip"), "zip-bytes");
  await writeFile(join(dir, "failure.png"), "png-bytes");
  return {
    ticket: TicketKeySchema.parse("SHOP-482"),
    runId: RunIdSchema.parse("20261003-1046-aaaa"),
    comment: { adf: { version: 1, type: "doc", content: [] }, wiki: "h3. results" },
    attachments: [
      {
        path: join(dir, "evidence.zip"),
        name: "SHOP-482_evidence.zip",
        mimeType: "application/zip",
        bytes: 9,
      },
      { path: join(dir, "failure.png"), name: "TC-01_failure.png", mimeType: "image/png", bytes: 9 },
    ],
    ...(previous ? { previous } : {}),
  };
};

/**
 * Shared contract every Publisher passes (REQ-PUB-01, REQ-PUB-02, REQ-PUB-04, REQ-GEN-02/AC3): one comment per
 * run, updated when published again; every attachment is either uploaded once or reported as skipped.
 *
 * @param name - Implementation name for test titles.
 * @param create - Builds a publisher backed by fixtures (no real Jira).
 */
export function publisherContract(name: string, create: () => Publisher): void {
  describe(`Publisher contract: ${name}`, () => {
    it("REQ-GEN-02/AC3 + REQ-PUB-02/AC1: a first publish creates a comment and accounts for every attachment once", async () => {
      const input = await publishInput();
      const result = await create().publish(input);
      expect(result.updated).toBe(false);
      expect(result.commentId).not.toBe("");
      const accounted = [...result.attachments.map((a) => a.name), ...result.skipped.map((s) => s.name)];
      expect(accounted.sort()).toEqual(input.attachments.map((a) => a.name).sort());
    });

    it("REQ-GEN-02/AC3 + REQ-PUB-04/AC1: publishing the same run again updates its comment and skips uploaded files", async () => {
      const first = await create().publish(await publishInput());
      const again = await create().publish(
        await publishInput({ commentId: first.commentId, attachmentNames: ["SHOP-482_evidence.zip"] }),
      );
      expect(again).toMatchObject({ updated: true, commentId: first.commentId });
      expect(again.attachments.map((a) => a.name)).not.toContain("SHOP-482_evidence.zip");
    });

    it("REQ-GEN-02/AC3: an aborted signal publishes nothing", async () => {
      await expect(create().publish(await publishInput(), AbortSignal.abort())).rejects.toThrow();
    });
  });
}
