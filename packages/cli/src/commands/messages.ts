import { createWebhookSiteCapture } from "@qajitsu/adapter-messages-webhooksite";
import { ConfigError, type CaseMessages, type MessageCapture, type MessageInbox } from "@qajitsu/core";
import type { RuntimePorts } from "../adapters.js";
import type { RunSession } from "../session.js";

/** Replaceable message capture (tests use an in-memory one). */
export interface MessagePorts {
  readonly messageCapture?: (session: RunSession) => MessageCapture;
}

/** The message inboxes of one run (REQ-ENV-08): one per case, created on first use, deleted when the run ends. */
export interface RunMessages {
  readonly forCase: (caseId: string) => CaseMessages;
  /** Deletes every inbox of the run (AC5); failures are reported, never fatal. */
  readonly deleteAll: () => Promise<string[]>;
}

/**
 * Message capture for a run (REQ-ENV-08), or undefined when `messages` is not configured. The provider's host must be
 * on the environment allowlist (AC4); its API key is a `secret://` reference. Every inbox is recorded in `run.json`
 * so it is deleted at the end of the run even when the run fails (AC5).
 *
 * @throws {ConfigError} `MESSAGES_HOST_NOT_ALLOWED`.
 */
export function runMessages(
  session: RunSession,
  ports: RuntimePorts & MessagePorts,
): RunMessages | undefined {
  const { project, ws, masker, logger } = session;
  const config = project.config.messages;
  if (!config) return undefined;
  const origin = new URL(config.base_url).origin;
  if (!project.config.environments.allowlist.map((a) => new URL(a).origin).includes(origin))
    throw new ConfigError(
      "MESSAGES_HOST_NOT_ALLOWED",
      `${origin} (messages.base_url) is not in environments.allowlist; add it to capture e-mails and webhooks.`,
      {},
    );
  const capture =
    ports.messageCapture?.(session) ??
    createWebhookSiteCapture(
      { baseUrl: config.base_url, emailDomain: config.email_domain, apiKey: config.api_key },
      {
        fetch: ports.fetch,
        logger,
        now: ports.now,
        resolveSecret: session.resolveSecret,
        registerSecret: (v) => {
          masker.register(v);
        },
      },
    );
  const inboxes = new Map<string, Promise<MessageInbox>>();
  let recording: Promise<void> = Promise.resolve();
  const record = (id: string): Promise<void> =>
    (recording = recording.then(async () => {
      const known = (ws.record.data["inboxes"] as string[] | undefined) ?? [];
      await ws.update({ data: { ...ws.record.data, inboxes: [...known, id] } });
    }));
  const system = { kind: "system", name: "orchestrator" } as const;
  return {
    forCase: (caseId) => ({
      capture,
      timeoutMs: config.timeout_s * 1000,
      pollMs: config.poll_ms,
      inbox: () => {
        let box = inboxes.get(caseId);
        if (!box) {
          box = capture.createInbox(`${ws.ticket}-${ws.runId}-${caseId}`).then(async (created) => {
            await record(created.id);
            session.events.emit("run", system, "inbox.created", { caseId });
            return created;
          });
          inboxes.set(caseId, box);
        }
        return box;
      },
    }),
    deleteAll: async () => {
      await recording;
      const problems: string[] = [];
      const ids = (ws.record.data["inboxes"] as string[] | undefined) ?? [];
      for (const id of ids)
        await capture.deleteInbox(id).catch((error: unknown) => {
          problems.push(masker.maskText(error instanceof Error ? error.message : String(error)));
        });
      if (ids.length > 0) {
        await ws.update({ data: { ...ws.record.data, inboxes: [] } });
        session.events.emit("run", system, "inbox.deleted", { count: ids.length, problems: problems.length });
      }
      return problems;
    },
  };
}
