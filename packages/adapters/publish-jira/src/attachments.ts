import { TicketKeySchema, createHttpClient, type AdapterDeps } from "@qajitsu/core";
import { z } from "zod";
import type { JiraPublisherConfig } from "./jira-publisher.js";

const IssueAttachments = z.object({
  fields: z.object({
    attachment: z
      .array(
        z.object({
          id: z.union([z.string(), z.number()]).transform(String),
          filename: z.string(),
          content: z.string(),
          size: z.number().optional(),
        }),
      )
      .default([]),
  }),
});

/** An attachment of a ticket. */
export interface TicketAttachment {
  readonly id: string;
  readonly filename: string;
  readonly content: string;
  readonly size?: number | undefined;
}

/**
 * Reads attachments of a ticket, e.g. the evidence zip a CI run published (REQ-PUB-06/AC3). Content
 * redirected to Jira's media host is downloaded without credentials.
 *
 * @param config - Same settings as the publisher.
 * @param deps - Injected fetch, logger, clock and secret resolver.
 */
export function createJiraAttachmentReader(
  config: Omit<JiraPublisherConfig, "maxAttachmentBytes">,
  deps: AdapterDeps,
) {
  const api = config.flavor === "cloud" ? "/rest/api/3" : "/rest/api/2";
  const http = createHttpClient({
    service: "JIRA",
    baseUrl: config.baseUrl,
    fetch: deps.fetch,
    headers: async () => {
      const token = await deps.resolveSecret(config.token);
      if (config.flavor === "datacenter" || config.email === undefined)
        return { authorization: `Bearer ${token}` };
      const email = await deps.resolveSecret(config.email);
      return { authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` };
    },
  });
  return {
    async list(ticket: string, signal?: AbortSignal): Promise<TicketAttachment[]> {
      const key = TicketKeySchema.parse(ticket);
      return (await http.json(`${api}/issue/${key}?fields=attachment`, IssueAttachments, { signal })).fields
        .attachment;
    },
    download(attachment: TicketAttachment, signal?: AbortSignal): Promise<Uint8Array> {
      return http.bytes(attachment.content, { signal, anonymousCrossOriginRedirect: true });
    },
  };
}
