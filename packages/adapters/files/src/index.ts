/**
 * Local-file adapters of the core installation (REQ-GEN-11/AC1, REQ-CTX-09/AC2): tickets, their workflow, the
 * publisher, the bug tracker, resolved bugs for the knowledge base and manual test cases, all from files, so QAJitsu
 * works from ticket to published result without any plugin (demo-shop, offline runs, tests).
 *
 * @packageDocumentation
 */
export { createFileTicketSource } from "./tickets.js";
export { createFileWorkflow } from "./workflow.js";
export { createFilePublisher } from "./publisher.js";
export { createFileBugTracker } from "./bug-tracker.js";
export { createFileBugSource } from "./bug-source.js";
export { createFileCaseSource, parseCsv } from "./cases.js";

/** Adapter metadata used by `qajitsu doctor` and the adapter table in the docs. */
export const ADAPTER = {
  kind: "files",
  name: "files",
  implements: "TicketSource, TicketWorkflow, Publisher, BugTracker, DocumentSource, TestCaseSource",
  roadmapStage: 1,
  requirements: ["REQ-CTX-01", "REQ-CTX-08", "REQ-PUB-01", "REQ-KNOW-12"],
  status: "implemented",
} as const;
