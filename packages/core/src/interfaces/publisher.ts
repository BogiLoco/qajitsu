import type { RunId, TicketKey } from "../identifiers.js";

/** Input for publishing a finished, gated run (REQ-PUB-01). */
export interface PublishInput {
  readonly ticket: TicketKey;
  readonly runId: RunId;
  /** Rendered matrix and summary, computed from structured results (REQ-VER-08). */
  readonly markdown: string;
  readonly attachments: readonly { readonly path: string; readonly name: string }[];
  /** Id of a comment published earlier for this run, for idempotent updates (REQ-PUB-04). */
  readonly previousId?: string;
}

/** Publishes results: Jira comment first; Xray, Zephyr, PR/MR comments later (REQ-PUB-05). */
export interface Publisher {
  readonly id: string;
  publish(input: PublishInput, signal?: AbortSignal): Promise<{ readonly id: string; readonly url?: string }>;
}
