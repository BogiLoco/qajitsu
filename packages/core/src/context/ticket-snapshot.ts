import { readFile } from "node:fs/promises";
import { z } from "zod";
import { TicketKeySchema } from "../identifiers.js";
import type { Ticket } from "../interfaces/ticket-source.js";

/** Schema of `ticket/ticket.json`, the frozen ticket snapshot of a run (REQ-CTX-01/AC2). */
export const TicketSnapshotSchema = z.strictObject({
  key: TicketKeySchema,
  summary: z.string(),
  description: z.string(),
  issueType: z.string(),
  status: z.string(),
  labels: z.array(z.string()),
  components: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  comments: z.array(z.strictObject({ author: z.string(), body: z.string(), created: z.string() })),
  linkedKeys: z.array(z.string()),
  attachments: z.array(z.strictObject({ name: z.string(), mimeType: z.string(), url: z.string() })),
  developmentLinks: z.array(
    z.strictObject({
      url: z.string(),
      kind: z.enum(["pr", "mr", "branch", "commit"]),
      title: z.string().optional(),
      sourceBranch: z.string().optional(),
      targetBranch: z.string().optional(),
    }),
  ),
});

/**
 * Reads the ticket snapshot of a run. Later stages use this, never the ticket source (REQ-CTX-01/AC2).
 *
 * @param file - Path of `ticket/ticket.json`.
 */
export async function readTicketSnapshot(file: string): Promise<Ticket> {
  return TicketSnapshotSchema.parse(JSON.parse(await readFile(file, "utf8")) as unknown);
}

/**
 * Renders a ticket as Markdown for humans and agents (`ticket/ticket.md`).
 *
 * @param ticket - Ticket snapshot.
 */
export function renderTicketMarkdown(ticket: Ticket): string {
  const lines = [
    `# ${ticket.key}: ${ticket.summary}`,
    "",
    `- Type: ${ticket.issueType}`,
    `- Status: ${ticket.status}`,
    ...(ticket.labels.length > 0 ? [`- Labels: ${ticket.labels.join(", ")}`] : []),
    ...(ticket.components.length > 0 ? [`- Components: ${ticket.components.join(", ")}`] : []),
    ...(ticket.linkedKeys.length > 0 ? [`- Linked: ${ticket.linkedKeys.join(", ")}`] : []),
    "",
    "## Description",
    "",
    ticket.description.trim() === "" ? "_(empty)_" : ticket.description.trim(),
    "",
    "## Acceptance criteria",
    "",
    ...(ticket.acceptanceCriteria.length > 0
      ? ticket.acceptanceCriteria.map((ac, i) => `${String(i + 1)}. ${ac}`)
      : ["_(none found)_"]),
  ];
  if (ticket.comments.length > 0) {
    lines.push("", "## Comments", "");
    for (const c of ticket.comments)
      lines.push(`- **${c.author}** (${c.created}): ${c.body.replaceAll("\n", " ")}`);
  }
  if (ticket.attachments.length > 0) {
    lines.push("", "## Attachments", "");
    for (const a of ticket.attachments) lines.push(`- ${a.name} (${a.mimeType})`);
  }
  if (ticket.developmentLinks.length > 0) {
    lines.push("", "## Development", "");
    for (const d of ticket.developmentLinks) {
      lines.push(`- ${d.kind}: ${[d.title ?? d.sourceBranch, d.url].filter(Boolean).join(" ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
