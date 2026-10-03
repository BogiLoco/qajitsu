/**
 * Jira Cloud TicketSource: ticket, acceptance criteria, comments, links, attachments and development panel.
 * Status: planned. Implement with the `/new-adapter` skill.
 *
 * @packageDocumentation
 */
export const ADAPTER = {
  kind: "ticket",
  name: "jira",
  implements: "TicketSource",
  roadmapStage: 1,
  requirements: ["REQ-CTX-01", "REQ-CTX-03"],
  status: "planned",
} as const;
