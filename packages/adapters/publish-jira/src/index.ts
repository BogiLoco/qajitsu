/**
 * Jira Publisher: result comment (ADF on Cloud, wiki markup on Data Center), attachments with size
 * checks and idempotent updates per run (REQ-PUB-01..04).
 *
 * @packageDocumentation
 */
export { createJiraPublisher, type JiraPublisherConfig } from "./jira-publisher.js";
export { createFilePublisher } from "./file-publisher.js";

/** Adapter metadata used by `qajitsu doctor` and the adapter table in the docs. */
export const ADAPTER = {
  kind: "publish",
  name: "jira",
  implements: "Publisher",
  roadmapStage: 4,
  requirements: ["REQ-PUB-01", "REQ-PUB-02", "REQ-PUB-03", "REQ-PUB-04"],
  status: "implemented",
} as const;
