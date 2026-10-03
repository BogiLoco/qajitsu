import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PublishResult, Publisher } from "@qajitsu/core";

/**
 * Publisher for `jira.type: file` (demo, offline): writes the comment as ADF and wiki markup into a
 * folder instead of sending it. Same idempotency contract as the Jira publisher.
 *
 * @param dir - Output folder, normally `<run>/report/published`.
 */
export function createFilePublisher(dir: string): Publisher {
  return {
    id: "file",
    async publish(input): Promise<PublishResult> {
      await mkdir(dir, { recursive: true });
      const commentId = input.previous?.commentId ?? `local-${input.runId}`;
      await writeFile(
        join(dir, "jira-comment.adf.json"),
        `${JSON.stringify(input.comment.adf, null, 2)}\n`,
        "utf8",
      );
      await writeFile(join(dir, "jira-comment.wiki.txt"), input.comment.wiki, "utf8");
      const already = new Set(input.previous?.attachmentNames ?? []);
      return {
        commentId,
        url: `file://${join(dir, "jira-comment.adf.json")}`,
        updated: input.previous !== undefined,
        attachments: input.attachments
          .filter((a) => !already.has(a.name))
          .map((a) => ({ name: a.name, id: a.path })),
        skipped: [],
      };
    },
  };
}
