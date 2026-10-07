import {
  AdapterError,
  createHttpClient,
  type AdapterDeps,
  type CapturedMessage,
  type MessageCapture,
} from "@qajitsu/core";
import { z } from "zod";

/** Where webhook.site runs and how to reach it. */
export interface WebhookSiteConfig {
  /** `https://webhook.site` or a self-hosted instance. */
  readonly baseUrl: string;
  /** Domain of the inbox e-mail addresses (`<token>@<domain>`); `email.webhook.site` for the hosted service. */
  readonly emailDomain: string;
  /** `secret://` reference of the API key (paid accounts, self-hosted instances with keys). */
  readonly apiKey?: string | undefined;
}

const TOKEN = /^[0-9a-f-]{36}$/;
const RequestSchema = z
  .object({
    uuid: z.string(),
    type: z.string().optional(),
    created_at: z.string(),
    content: z.string().nullish(),
    text_content: z.string().nullish(),
    headers: z.record(z.string(), z.union([z.array(z.string()), z.string()])).nullish(),
    url: z.string().nullish(),
  })
  .loose();

const header = (
  headers: Record<string, string | string[]> | null | undefined,
  name: string,
): string | undefined => {
  const value = Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? value[0] : value;
};

/** `2026-10-07 10:00:00` (UTC, as webhook.site returns it) or ISO, to ISO 8601. */
const isoOf = (value: string): string => {
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date(0).toISOString();
};

/** Headers and body of a raw e-mail (RFC 5322); quoted-printable soft breaks are joined. */
const parseRawEmail = (raw: string): { headers: Record<string, string>; body: string } => {
  const [head = "", ...rest] = raw.split(/\r?\n\r?\n/);
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return { headers, body: rest.join("\n\n").replace(/=\r?\n/g, "") };
};

/**
 * MessageCapture on webhook.site (REQ-ENV-08): one token per run and case gives an e-mail address
 * (`<token>@<emailDomain>`) and a URL; requests are read newest first and the token is deleted at cleanup.
 *
 * @param config - Base URL, e-mail domain and an optional API key reference.
 * @param deps - Injected fetch, logger, clock and secret resolver.
 * @example
 * const capture = createWebhookSiteCapture({ baseUrl: "https://webhook.site", emailDomain: "email.webhook.site" }, deps);
 */
export function createWebhookSiteCapture(config: WebhookSiteConfig, deps: AdapterDeps): MessageCapture {
  const base = config.baseUrl.replace(/\/+$/, "");
  if (!base.startsWith("https://") && !/^http:\/\/(localhost|127\.\d+\.\d+\.\d+)(:\d+)?$/.test(base))
    throw new AdapterError(
      "WEBHOOKSITE_URL_INSECURE",
      "webhook.site must be reached over https (or localhost).",
      {},
    );
  const http = createHttpClient({
    service: "WEBHOOKSITE",
    baseUrl: base,
    fetch: deps.fetch,
    headers: async () => {
      if (config.apiKey === undefined) return { accept: "application/json" };
      const key = await deps.resolveSecret(config.apiKey);
      deps.registerSecret(key);
      return { accept: "application/json", "api-key": key };
    },
  });
  const checked = (id: string): string => {
    if (!TOKEN.test(id))
      throw new AdapterError("WEBHOOKSITE_TOKEN_INVALID", "Invalid webhook.site token.", {});
    return id;
  };
  return {
    async createInbox(label, signal) {
      const token = await http.json("/token", z.object({ uuid: z.string().regex(TOKEN) }).loose(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ default_status: 200, default_content: "ok", alias: label.slice(0, 60) }),
        signal,
      });
      return { id: token.uuid, email: `${token.uuid}@${config.emailDomain}`, url: `${base}/${token.uuid}` };
    },
    async messages(inboxId, signal) {
      const page = await http.json(
        `/token/${checked(inboxId)}/requests?sorting=newest&per_page=50`,
        z.object({ data: z.array(RequestSchema) }).loose(),
        { signal },
      );
      return page.data.map((r): CapturedMessage => {
        if (r.type === "email") {
          const raw = parseRawEmail(r.content ?? "");
          return {
            id: r.uuid,
            kind: "email",
            receivedAt: isoOf(r.created_at),
            from: header(r.headers, "from") ?? raw.headers["from"],
            to: header(r.headers, "to") ?? raw.headers["to"],
            subject: header(r.headers, "subject") ?? raw.headers["subject"],
            body: r.text_content ?? raw.body,
          };
        }
        return {
          id: r.uuid,
          kind: "http",
          receivedAt: isoOf(r.created_at),
          to: r.url ?? undefined,
          body: r.content ?? "",
        };
      });
    },
    async deleteInbox(inboxId, signal) {
      await http.text(`/token/${checked(inboxId)}`, { method: "DELETE", signal });
    },
  };
}
