import type { TicketKey } from "../identifiers.js";

/** A transition the ticket's workflow offers from its current status. */
export interface TicketTransition {
  readonly id: string;
  readonly name: string;
  /** Status the transition leads to. */
  readonly to: string;
}

/** A comment on the ticket, as plain text, with its author's account (REQ-FLOW-03). */
export interface TicketComment {
  readonly id: string;
  /** Jira Cloud account id or Data Center user name, and the display name. */
  readonly author: { readonly account: string; readonly name: string };
  readonly body: string;
  /** ISO time the comment was created. */
  readonly created: string;
}

/**
 * The ticket's workflow in the tracker (REQ-FLOW-02): its status, the transitions offered from it, and moving it.
 * Implemented for Jira Cloud and Data Center, and for ticket files (demo, offline, tests). Code decides when to move a
 * ticket (REQ-FLOW-04/AC4); no agent tool reaches this interface.
 */
export interface TicketWorkflow {
  readonly id: string;
  status(ticket: TicketKey, signal?: AbortSignal): Promise<string>;
  transitions(ticket: TicketKey, signal?: AbortSignal): Promise<readonly TicketTransition[]>;
  transition(ticket: TicketKey, transitionId: string, signal?: AbortSignal): Promise<void>;
  /** Assigns the ticket to an account (Jira Cloud account id, Data Center user name). */
  assign(ticket: TicketKey, account: string, signal?: AbortSignal): Promise<void>;
  addLabel(ticket: TicketKey, label: string, signal?: AbortSignal): Promise<void>;
  /** Every status of the project's workflows, for `qj doctor` (REQ-FLOW-02/AC2). */
  projectStatuses(projectKey: string, signal?: AbortSignal): Promise<readonly string[]>;
  /** Whether the account may transition the project's tickets (REQ-FLOW-02/AC2). */
  canTransition(projectKey: string, signal?: AbortSignal): Promise<boolean>;
  /** The ticket's comments, oldest first (REQ-FLOW-03/AC2). Their text is untrusted data. */
  comments(ticket: TicketKey, signal?: AbortSignal): Promise<readonly TicketComment[]>;
  /** Whether an account is a member of a group of the tracker (REQ-FLOW-03/AC3). */
  inGroup(account: string, group: string, signal?: AbortSignal): Promise<boolean>;
}
