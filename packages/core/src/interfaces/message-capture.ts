/** An inbox of one case of one run (REQ-ENV-08/AC1): an e-mail address and a webhook URL. */
export interface MessageInbox {
  readonly id: string;
  readonly email: string;
  readonly url: string;
}

/** A message received by an inbox: an e-mail, or an HTTP request (SMS gateway, outgoing webhook). */
export interface CapturedMessage {
  readonly id: string;
  readonly kind: "email" | "http";
  /** ISO 8601. */
  readonly receivedAt: string;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly subject?: string | undefined;
  readonly body: string;
}

/**
 * A message capture service (REQ-ENV-08): webhook.site first. Inboxes are created per run and case and deleted at
 * cleanup; their host must be on the environment allowlist.
 */
export interface MessageCapture {
  createInbox(label: string, signal?: AbortSignal): Promise<MessageInbox>;
  /** Messages of the inbox, newest first. */
  messages(inboxId: string, signal?: AbortSignal): Promise<readonly CapturedMessage[]>;
  deleteInbox(inboxId: string, signal?: AbortSignal): Promise<void>;
}

/** What a case attempt uses: its own inbox, created on first use, and the capture service to read it. */
export interface CaseMessages {
  readonly inbox: () => Promise<MessageInbox>;
  readonly capture: MessageCapture;
  /** Default wait when the plan gives no `within_s`. */
  readonly timeoutMs: number;
  readonly pollMs?: number | undefined;
}
