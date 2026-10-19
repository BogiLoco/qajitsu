import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunId, TicketKey } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { createFilePublisher } from "./file-publisher.js";

let dir: string;
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const input = (name: string | undefined, text: string) => ({
  ticket: "DEMO-1" as TicketKey,
  runId: "20261018-1000-aaaa" as RunId,
  comment: { adf: { text }, wiki: text },
  attachments: [],
  ...(name === undefined ? {} : { name }),
});

describe("file publisher", () => {
  it("REQ-PLAN-10/AC4: named comments are separate comments, each in its own files; the results comment stays where it was", async () => {
    dir = await mkdtemp(join(tmpdir(), "qj-file-pub-"));
    const publisher = createFilePublisher(dir);
    const results = await publisher.publish(input(undefined, "results"));
    const first = await publisher.publish(input("approval-1", "step 1"));
    const second = await publisher.publish(input("approval-2", "step 2"));
    expect([results.commentId, first.commentId, second.commentId]).toEqual([
      "local-20261018-1000-aaaa",
      "local-20261018-1000-aaaa-approval-1",
      "local-20261018-1000-aaaa-approval-2",
    ]);
    expect((await readdir(dir)).sort()).toEqual([
      "jira-comment.adf.json",
      "jira-comment.approval-1.adf.json",
      "jira-comment.approval-1.wiki.txt",
      "jira-comment.approval-2.adf.json",
      "jira-comment.approval-2.wiki.txt",
      "jira-comment.wiki.txt",
    ]);
    expect(await readFile(join(dir, "jira-comment.approval-2.wiki.txt"), "utf8")).toBe("step 2");
    expect(await readFile(join(dir, "jira-comment.wiki.txt"), "utf8")).toBe("results");
  });
});
