import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { AdapterError, TicketKeySchema, type Ticket, type TicketKey, type TicketSource } from "@qajitsu/core";
import { z } from "zod";

const FileTicketSchema = z.object({
  key: z.string(),
  type: z.string().default("Story"),
  status: z.string().default("Unknown"),
  summary: z.string(),
  description: z.string().default(""),
  acceptanceCriteria: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
  components: z.array(z.string()).default([]),
  links: z
    .object({
      issues: z.array(z.string()).default([]),
      pullRequests: z
        .array(
          z.object({
            url: z.string().optional(),
            host: z.string(),
            repo: z.string(),
            number: z.number().int().positive(),
            title: z.string().optional(),
            sourceBranch: z.string().optional(),
            targetBranch: z.string().optional(),
          }),
        )
        .default([]),
    })
    .default({ issues: [], pullRequests: [] }),
  attachments: z.array(z.object({ name: z.string(), mimeType: z.string(), url: z.string() })).default([]),
  comments: z.array(z.object({ author: z.string(), created: z.string(), body: z.string() })).default([]),
});

/**
 * TicketSource that reads `<dir>/<KEY>.json` (demo-shop format). Used for offline demos,
 * contract and e2e tests; behaves like Jira for everything downstream.
 *
 * @param dir - Directory holding ticket files.
 * @example
 * const source = createFileTicketSource("examples/demo-shop/tickets");
 */
export function createFileTicketSource(dir: string): TicketSource {
  return {
    async check() {
      const ok = await stat(dir).then(
        (st) => st.isDirectory(),
        () => false,
      );
      return { ok, detail: ok ? `ticket files in ${dir}` : `${dir} not found` };
    },
    async getTicket(key: TicketKey, signal?: AbortSignal): Promise<Ticket> {
      const safeKey = TicketKeySchema.parse(key);
      signal?.throwIfAborted();
      let text: string;
      try {
        text = await readFile(join(dir, `${safeKey}.json`), "utf8");
      } catch {
        throw new AdapterError("JIRA_NOT_FOUND", `Ticket ${safeKey} was not found in ${dir}.`, {
          key: safeKey,
        });
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text) as unknown;
      } catch {
        throw new AdapterError("JIRA_MALFORMED", `Ticket file for ${safeKey} is not valid JSON.`, {
          key: safeKey,
        });
      }
      const parsed = FileTicketSchema.safeParse(raw);
      if (!parsed.success || parsed.data.key !== safeKey) {
        throw new AdapterError("JIRA_MALFORMED", `Ticket file for ${safeKey} is invalid.`, { key: safeKey });
      }
      const t = parsed.data;
      return {
        key: safeKey,
        summary: t.summary,
        description: t.description,
        issueType: t.type,
        status: t.status,
        labels: t.labels,
        components: t.components,
        acceptanceCriteria: t.acceptanceCriteria,
        comments: t.comments,
        linkedKeys: t.links.issues,
        attachments: t.attachments,
        developmentLinks: t.links.pullRequests.map((pr) => ({
          url: pr.url ?? `https://${pr.host}.com/${pr.repo}/pull/${String(pr.number)}`,
          kind: "pr" as const,
          ...(pr.title ? { title: pr.title } : {}),
          ...(pr.sourceBranch ? { sourceBranch: pr.sourceBranch } : {}),
          ...(pr.targetBranch ? { targetBranch: pr.targetBranch } : {}),
        })),
      };
    },
  };
}
