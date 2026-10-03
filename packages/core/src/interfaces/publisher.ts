import type { RunId, TicketKey } from "../identifiers.js";

/** One file to attach to the ticket (REQ-PUB-02). */
export interface PublishAttachment {
  /** Absolute path of the file on disk. */
  readonly path: string;
  /** File name in the ticket. */
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: number;
}

/** Input for publishing a finished, gated run (REQ-PUB-01). */
export interface PublishInput {
  readonly ticket: TicketKey;
  readonly runId: RunId;
  /** The comment, rendered from computed results only (REQ-VER-08): ADF for Cloud, wiki markup for Data Center. */
  readonly comment: { readonly adf: unknown; readonly wiki: string };
  readonly attachments: readonly PublishAttachment[];
  /** What this run published before, for idempotent updates (REQ-PUB-04). */
  readonly previous?: { readonly commentId: string; readonly attachmentNames: readonly string[] } | undefined;
}

/** What a publisher did. */
export interface PublishResult {
  readonly commentId: string;
  readonly url?: string | undefined;
  /** Whether an existing comment was updated instead of a new one created. */
  readonly updated: boolean;
  readonly attachments: readonly { readonly name: string; readonly id: string }[];
  /** Attachments not uploaded, e.g. over the size limit (REQ-PUB-02/AC3). */
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
}

/** Publishes results: Jira comment first; Xray, Zephyr, PR/MR comments later (REQ-PUB-05). */
export interface Publisher {
  readonly id: string;
  publish(input: PublishInput, signal?: AbortSignal): Promise<PublishResult>;
}
