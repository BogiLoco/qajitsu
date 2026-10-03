/**
 * Jira Publisher: result comment, attachments with size checks, idempotent updates.
 * Status: planned. Implement with `/new-adapter`.
 *
 * @packageDocumentation
 */
export const ADAPTER = {
  kind: "publish",
  name: "jira",
  implements: "Publisher",
  roadmapStage: 4,
  requirements: ["REQ-PUB-01", "REQ-PUB-02", "REQ-PUB-03", "REQ-PUB-04"],
  status: "planned",
} as const;
