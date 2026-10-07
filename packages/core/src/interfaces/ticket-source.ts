import type { TicketKey } from "../identifiers.js";

/** A PR/MR, branch or commit linked from the Jira development panel (REQ-CTX-03/AC1). */
export interface DevelopmentLink {
  readonly url: string;
  readonly kind: "pr" | "mr" | "branch" | "commit";
  readonly title?: string | undefined;
  readonly sourceBranch?: string | undefined;
  readonly targetBranch?: string | undefined;
}

/** A ticket snapshot as stored in the run workspace under `ticket/` (REQ-CTX-01). */
export interface Ticket {
  readonly key: TicketKey;
  readonly summary: string;
  /** Description converted to Markdown. */
  readonly description: string;
  readonly issueType: string;
  readonly status: string;
  readonly labels: readonly string[];
  readonly components: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly comments: readonly { readonly author: string; readonly body: string; readonly created: string }[];
  readonly linkedKeys: readonly string[];
  readonly attachments: readonly { readonly name: string; readonly mimeType: string; readonly url: string }[];
  /** Pull/merge requests and branches from the Jira development panel, when available (REQ-CTX-03). */
  readonly developmentLinks: readonly DevelopmentLink[];
}

/** Source of tickets: Jira Cloud first, Jira Data Center and others later (REQ-CTX-01, REQ-GEN-02). */
/** Tickets of a release or sprint (REQ-PUB-09/AC1). */
export interface ReleaseQuery {
  readonly fixVersion?: string | undefined;
  readonly sprint?: string | undefined;
}

/** One ticket of a release, as listed by the tracker. */
export interface ReleaseTicket {
  readonly key: string;
  readonly summary: string;
  readonly status: string;
}

export interface TicketSource {
  getTicket(key: TicketKey, signal?: AbortSignal): Promise<Ticket>;
  /** Tickets of the project in a fix version or sprint (REQ-PUB-09/AC1). */
  findTickets?(query: ReleaseQuery, signal?: AbortSignal): Promise<readonly ReleaseTicket[]>;
  /** Cheap access check for `qajitsu doctor --online` (REQ-GEN-03/AC2); never returns secrets. */
  check?(signal?: AbortSignal): Promise<{ readonly ok: boolean; readonly detail: string }>;
}
