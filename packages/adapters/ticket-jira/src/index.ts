/**
 * Jira TicketSource: Jira Cloud REST v3 (ticket, acceptance criteria, comments, links, attachments,
 * development panel) (REQ-CTX-01, REQ-CTX-03). Tickets from files are in `@qajitsu/adapter-files`.
 *
 * @packageDocumentation
 */
export {
  adfToMarkdown,
  extractAcceptanceCriteria,
  wikiToMarkdown,
  AdfNodeSchema,
  type AdfNode,
} from "./adf.js";
export { createJiraCloudTicketSource, DEV_PANEL_APPLICATIONS, type JiraCloudConfig } from "./jira-cloud.js";
export { createJiraBugSource, MAX_BUGS } from "./jira-bugs.js";

/** Adapter metadata used by `qajitsu doctor` and the adapter table in the docs. */
export const ADAPTER = {
  kind: "ticket",
  name: "jira",
  implements: "TicketSource",
  roadmapStage: 1,
  requirements: ["REQ-CTX-01", "REQ-CTX-03"],
  status: "implemented",
} as const;
