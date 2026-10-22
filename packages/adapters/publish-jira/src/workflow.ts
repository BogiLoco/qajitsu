import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AdapterError,
  TicketKeySchema,
  createHttpClient,
  type AdapterDeps,
  type TicketKey,
  type TicketComment,
  type TicketTransition,
  type TicketWorkflow,
} from "@qajitsu/core";
import { z } from "zod";
import type { JiraPublisherConfig } from "./jira-publisher.js";

/**
 * Jira's workflow (REQ-FLOW-02): status and transitions of an issue (Cloud REST v3, Data Center REST v2), moving it,
 * assigning it and labelling it, the statuses of a project and the TRANSITION_ISSUES permission of the account.
 *
 * @param config - Flavor, base URL and credentials, as for publishing.
 * @param deps - Injected fetch, logger, clock and secret resolver.
 */
export function createJiraWorkflow(
  config: Pick<JiraPublisherConfig, "flavor" | "baseUrl" | "email" | "token">,
  deps: AdapterDeps,
): TicketWorkflow {
  const cloud = config.flavor === "cloud";
  const api = cloud ? "/rest/api/3" : "/rest/api/2";
  const http = createHttpClient({
    service: "JIRA",
    baseUrl: config.baseUrl,
    fetch: deps.fetch,
    headers: async () => {
      const token = await deps.resolveSecret(config.token);
      deps.registerSecret(token);
      if (!cloud) return { authorization: `Bearer ${token}` };
      if (config.email === undefined)
        throw new AdapterError("JIRA_AUTH_MISSING", "Jira Cloud needs an e-mail and a token.", {});
      const email = await deps.resolveSecret(config.email);
      return { authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` };
    },
  });
  const json = { "content-type": "application/json" };
  const issue = (key: TicketKey): string => `${api}/issue/${encodeURIComponent(TicketKeySchema.parse(key))}`;
  const project = (key: string): string => {
    if (!/^[A-Z][A-Z0-9_]+$/.test(key))
      throw new AdapterError("JIRA_PROJECT_INVALID", "Invalid Jira project key.", {});
    return key;
  };
  return {
    id: `jira-${config.flavor}`,
    async status(ticket, signal) {
      const r = await http.json(
        `${issue(ticket)}?fields=status`,
        z.object({ fields: z.object({ status: z.object({ name: z.string() }) }) }),
        { signal },
      );
      return r.fields.status.name;
    },
    async transitions(ticket, signal): Promise<readonly TicketTransition[]> {
      const r = await http.json(
        `${issue(ticket)}/transitions`,
        z.object({
          transitions: z.array(
            z.object({ id: z.string(), name: z.string(), to: z.object({ name: z.string() }) }),
          ),
        }),
        { signal },
      );
      return r.transitions.map((t) => ({ id: t.id, name: t.name, to: t.to.name }));
    },
    async transition(ticket, transitionId, signal) {
      await http.text(`${issue(ticket)}/transitions`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ transition: { id: transitionId } }),
        signal,
      });
    },
    async assign(ticket, account, signal) {
      await http.text(`${issue(ticket)}/assignee`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify(cloud ? { accountId: account } : { name: account }),
        signal,
      });
    },
    async addLabel(ticket, label, signal) {
      await http.text(issue(ticket), {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ update: { labels: [{ add: label }] } }),
        signal,
      });
    },
    async projectStatuses(projectKey, signal) {
      const r = await http.json(
        `${api}/project/${project(projectKey)}/statuses`,
        z.array(z.object({ statuses: z.array(z.object({ name: z.string() })) })),
        { signal },
      );
      return [...new Set(r.flatMap((t) => t.statuses.map((s) => s.name)))];
    },
    async canTransition(projectKey, signal) {
      const query = new URLSearchParams({
        projectKey: project(projectKey),
        permissions: "TRANSITION_ISSUES",
      });
      const r = await http.json(
        `${api}/mypermissions?${query.toString()}`,
        z.object({ permissions: z.record(z.string(), z.object({ havePermission: z.boolean() })) }),
        { signal },
      );
      return r.permissions["TRANSITION_ISSUES"]?.havePermission === true;
    },
    async comments(ticket, signal): Promise<readonly TicketComment[]> {
      const out: TicketComment[] = [];
      for (let startAt = 0; out.length < 1000;) {
        const query = new URLSearchParams({
          startAt: String(startAt),
          maxResults: "100",
          orderBy: "created",
        });
        const r = await http.json(`${issue(ticket)}/comment?${query.toString()}`, CommentPage, { signal });
        for (const c of r.comments)
          out.push({
            id: c.id,
            author: {
              account: c.author?.accountId ?? c.author?.name ?? "",
              name: c.author?.displayName ?? "",
            },
            body: typeof c.body === "string" ? c.body : adfText(c.body),
            created: c.created,
          });
        startAt += r.comments.length;
        if (r.comments.length === 0 || startAt >= r.total) break;
      }
      return out;
    },
    async inGroup(account, group, signal) {
      if (account === "") return false;
      if (cloud) {
        const r = await http.json(
          `${api}/user/groups?${new URLSearchParams({ accountId: account }).toString()}`,
          z.array(z.object({ name: z.string() })),
          { signal },
        );
        return r.some((g) => g.name === group);
      }
      const r = await http.json(
        `${api}/user?${new URLSearchParams({ username: account, expand: "groups" }).toString()}`,
        z.object({ groups: z.object({ items: z.array(z.object({ name: z.string() })) }) }),
        { signal },
      );
      return r.groups.items.some((g) => g.name === group);
    },
  };
}

const CommentPage = z.object({
  total: z.number().int().nonnegative(),
  comments: z.array(
    z.object({
      id: z.string(),
      author: z
        .object({
          accountId: z.string().optional(),
          name: z.string().optional(),
          displayName: z.string().optional(),
        })
        .optional(),
      body: z.unknown(),
      created: z.string(),
    }),
  ),
});

/** The plain text of an Atlassian document (a Cloud comment body); paragraphs on their own lines. */
export function adfText(node: unknown, depth = 0): string {
  if (depth > 50 || node === null || typeof node !== "object") return "";
  const n = node as { type?: unknown; text?: unknown; content?: unknown };
  if (n.type === "text" && typeof n.text === "string") return n.text;
  if (n.type === "hardBreak") return "\n";
  const inner = Array.isArray(n.content) ? n.content.map((c) => adfText(c, depth + 1)).join("") : "";
  return n.type === "paragraph" || n.type === "heading" || n.type === "codeBlock" ? `${inner}\n` : inner;
}

/**
 * The workflow of ticket files (demo, offline, tests): the status lives in `<KEY>.json`; `workflow.json` next to the
 * tickets may list the transitions per status (`{ "transitions": { "Ready for QA": ["In QA"] } }`), otherwise any
 * status can follow any other. Assignee and labels are written into the ticket file.
 *
 * @param ticketsDir - The folder of the ticket files.
 * @param statuses - The statuses the project maps (`workflow.statuses`): without `workflow.json` every one is offered.
 */
export function createFileWorkflow(ticketsDir: string, statuses: readonly string[] = []): TicketWorkflow {
  const file = (ticket: TicketKey): string => join(ticketsDir, `${TicketKeySchema.parse(ticket)}.json`);
  const read = async (ticket: TicketKey): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(file(ticket), "utf8")) as Record<string, unknown>;
  const write = (ticket: TicketKey, data: Record<string, unknown>): Promise<void> =>
    writeFile(file(ticket), `${JSON.stringify(data, null, 2)}\n`);
  const rules = async (): Promise<Record<string, string[]> | undefined> => {
    try {
      const w = JSON.parse(await readFile(join(ticketsDir, "workflow.json"), "utf8")) as {
        transitions?: Record<string, string[]>;
      };
      return w.transitions;
    } catch {
      return undefined;
    }
  };
  const statusOf = (t: Record<string, unknown>): string =>
    typeof t["status"] === "string" ? t["status"] : "";
  const allStatuses = async (): Promise<string[]> => {
    const r = await rules();
    return r ? [...new Set([...Object.keys(r), ...Object.values(r).flat()])] : [...statuses];
  };
  return {
    id: "file",
    async status(ticket) {
      return statusOf(await read(ticket));
    },
    async transitions(ticket) {
      const from = statusOf(await read(ticket));
      const r = await rules();
      // Without workflow.json, the transitions are to every status the project maps (open workflow).
      const targets = r ? (r[from] ?? []) : statuses.filter((s) => s !== from);
      return targets.map((to) => ({ id: `to:${to}`, name: `to ${to}`, to }));
    },
    async transition(ticket, transitionId) {
      const to = transitionId.replace(/^to:/, "");
      const t = await read(ticket);
      const r = await rules();
      if (r && !(r[statusOf(t)] ?? []).includes(to))
        throw new AdapterError(
          "WORKFLOW_TRANSITION_MISSING",
          `No transition from "${statusOf(t)}" to "${to}".`,
          {},
        );
      await write(ticket, { ...t, status: to });
    },
    async assign(ticket, account) {
      await write(ticket, { ...(await read(ticket)), assignee: account });
    },
    async addLabel(ticket, label) {
      const t = await read(ticket);
      const labels = Array.isArray(t["labels"]) ? (t["labels"] as string[]) : [];
      await write(ticket, { ...t, labels: labels.includes(label) ? labels : [...labels, label] });
    },
    async projectStatuses() {
      return allStatuses();
    },
    canTransition() {
      return Promise.resolve(true);
    },
    async comments(ticket) {
      const t = await read(ticket);
      const list = Array.isArray(t["comments"]) ? (t["comments"] as unknown[]) : [];
      return list.flatMap((c, i): TicketComment[] => {
        const r = FileComment.safeParse(c);
        if (!r.success) return [];
        return [
          {
            id: r.data.id ?? String(i + 1),
            author: { account: r.data.account ?? r.data.author, name: r.data.author },
            body: r.data.body,
            created: r.data.created,
          },
        ];
      });
    },
    async inGroup(account, group) {
      try {
        const w = JSON.parse(await readFile(join(ticketsDir, "workflow.json"), "utf8")) as {
          groups?: Record<string, unknown>;
        };
        const members = w.groups?.[group];
        return Array.isArray(members) && members.includes(account);
      } catch {
        return false;
      }
    },
  };
}

const FileComment = z.object({
  id: z.string().optional(),
  author: z.string(),
  account: z.string().optional(),
  body: z.string(),
  created: z.string(),
});
