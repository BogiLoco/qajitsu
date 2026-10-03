import { readFile } from "node:fs/promises";
import {
  AdapterError,
  TicketKeySchema,
  createHttpClient,
  type AdapterDeps,
  type PublishInput,
  type PublishResult,
  type Publisher,
} from "@qajitsu/core";
import { z } from "zod";

/** Settings of the Jira publisher. */
export interface JiraPublisherConfig {
  /** `cloud`: REST v3 with ADF; `datacenter`: REST v2 with wiki markup (REQ-PUB-03). */
  readonly flavor: "cloud" | "datacenter";
  readonly baseUrl: string;
  /** `secret://` reference of the account e-mail (Cloud basic auth). */
  readonly email?: string | undefined;
  /** `secret://` reference of the API token (Cloud) or personal access token (Data Center). */
  readonly token: string;
  /** Attachments above this size are not uploaded (REQ-PUB-02/AC3). */
  readonly maxAttachmentBytes: number;
}

const CommentSchema = z.object({ id: z.string() }).loose();
const AttachmentsSchema = z.array(
  z.object({ id: z.union([z.string(), z.number()]).transform(String), filename: z.string() }).loose(),
);

/**
 * Creates the Jira publisher (REQ-PUB-01..04). Publishing again for the same run updates its comment;
 * attachments already uploaded for the run are not uploaded twice.
 *
 * @param config - Flavor, base URL, credentials and attachment limit.
 * @param deps - Injected fetch, logger, clock and secret resolver.
 * @example
 * const publisher = createJiraPublisher({ flavor: "cloud", baseUrl, email, token, maxAttachmentBytes: 10e6 }, deps);
 * const result = await publisher.publish(input);
 */
export function createJiraPublisher(
  config: JiraPublisherConfig,
  deps: AdapterDeps & { readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void> },
): Publisher {
  const api = config.flavor === "cloud" ? "/rest/api/3" : "/rest/api/2";
  const http = createHttpClient({
    service: "JIRA",
    baseUrl: config.baseUrl,
    fetch: deps.fetch,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    headers: async () => {
      const token = await deps.resolveSecret(config.token);
      if (config.flavor === "datacenter") return { authorization: `Bearer ${token}` };
      if (config.email === undefined)
        throw new AdapterError("JIRA_AUTH_MISSING", "Jira Cloud needs an e-mail and a token.", {});
      const email = await deps.resolveSecret(config.email);
      return { authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` };
    },
  });
  const body = (input: PublishInput): string =>
    JSON.stringify({ body: config.flavor === "cloud" ? input.comment.adf : input.comment.wiki });
  const browse = (key: string, id: string): string =>
    `${new URL(config.baseUrl).origin}/browse/${key}?focusedCommentId=${id}`;

  return {
    id: `jira-${config.flavor}`,
    async publish(input, signal): Promise<PublishResult> {
      const key = TicketKeySchema.parse(input.ticket);
      const json = { "content-type": "application/json" };
      let commentId: string | undefined;
      let updated = false;
      if (input.previous) {
        try {
          const res = await http.json(
            `${api}/issue/${key}/comment/${encodeURIComponent(input.previous.commentId)}`,
            CommentSchema,
            {
              method: "PUT",
              headers: json,
              body: body(input),
              signal,
            },
          );
          commentId = res.id;
          updated = true;
        } catch (error) {
          // The earlier comment was deleted in Jira: publish a new one instead of failing.
          if (!(error instanceof AdapterError) || error.code !== "JIRA_NOT_FOUND") throw error;
        }
      }
      commentId ??= (
        await http.json(`${api}/issue/${key}/comment`, CommentSchema, {
          method: "POST",
          headers: json,
          body: body(input),
          signal,
        })
      ).id;

      const already = new Set(input.previous?.attachmentNames ?? []);
      const attachments: { name: string; id: string }[] = [];
      const skipped: { name: string; reason: string }[] = [];
      for (const file of input.attachments) {
        if (already.has(file.name)) continue;
        if (file.bytes > config.maxAttachmentBytes) {
          skipped.push({
            name: file.name,
            reason: `${String(Math.ceil(file.bytes / 1e6))} MB is over the ${String(Math.floor(config.maxAttachmentBytes / 1e6))} MB limit`,
          });
          continue;
        }
        const form = new FormData();
        form.append(
          "file",
          new Blob([new Uint8Array(await readFile(file.path))], { type: file.mimeType }),
          file.name,
        );
        const uploaded = await http.json(`${api}/issue/${key}/attachments`, AttachmentsSchema, {
          method: "POST",
          headers: { "x-atlassian-token": "no-check" },
          body: form,
          signal,
        });
        for (const a of uploaded) attachments.push({ name: a.filename, id: a.id });
      }
      deps.logger.info(
        { key, commentId, updated, attachments: attachments.length, skipped: skipped.length },
        "Published results to Jira",
      );
      return { commentId, url: browse(key, commentId), updated, attachments, skipped };
    },
  };
}
