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
    async publish(input, signal): Promise<PublishResult> {
      signal?.throwIfAborted();
      await mkdir(dir, { recursive: true });
      // Each named comment has its own files, as each is its own comment in Jira (REQ-PLAN-10/AC4).
      const suffix = input.name === undefined ? "" : `.${input.name.replace(/[^\w.-]/g, "_")}`;
      const commentId =
        input.previous?.commentId ??
        `local-${input.runId}${input.name === undefined ? "" : `-${input.name}`}`;
      const adf = join(dir, `jira-comment${suffix}.adf.json`);
      await writeFile(adf, `${JSON.stringify(input.comment.adf, null, 2)}\n`, "utf8");
      await writeFile(join(dir, `jira-comment${suffix}.wiki.txt`), input.comment.wiki, "utf8");
      const already = new Set(input.previous?.attachmentNames ?? []);
      return {
        commentId,
        url: `file://${adf}`,
        updated: input.previous !== undefined,
        attachments: input.attachments
          .filter((a) => !already.has(a.name))
          .map((a) => ({ name: a.name, id: a.path })),
        skipped: [],
      };
    },
  };
}
