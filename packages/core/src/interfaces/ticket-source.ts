import type { TicketKey } from "../identifiers.js";

/** A ticket snapshot as stored in the run workspace under `ticket/` (REQ-CTX-01). */
export interface Ticket {
  readonly key: TicketKey;
  readonly summary: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly comments: readonly { readonly author: string; readonly body: string; readonly created: string }[];
  readonly linkedKeys: readonly string[];
  readonly attachments: readonly { readonly name: string; readonly mimeType: string; readonly url: string }[];
  /** Pull/merge requests and branches from the Jira development panel, when available (REQ-CTX-03). */
  readonly developmentLinks: readonly {
    readonly url: string;
    readonly kind: "pr" | "mr" | "branch" | "commit";
  }[];
}

/** Source of tickets: Jira Cloud first, Jira Data Center and others later (REQ-CTX-01, REQ-GEN-02). */
export interface TicketSource {
  getTicket(key: TicketKey, signal?: AbortSignal): Promise<Ticket>;
}
