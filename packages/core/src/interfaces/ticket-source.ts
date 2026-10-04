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
export interface TicketSource {
  getTicket(key: TicketKey, signal?: AbortSignal): Promise<Ticket>;
  /** Cheap access check for `qajitsu doctor --online` (REQ-GEN-03/AC2); never returns secrets. */
  check?(signal?: AbortSignal): Promise<{ readonly ok: boolean; readonly detail: string }>;
}
