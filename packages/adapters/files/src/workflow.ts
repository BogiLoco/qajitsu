import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AdapterError,
  TicketKeySchema,
  type TicketComment,
  type TicketKey,
  type TicketWorkflow,
} from "@qajitsu/core";
import { z } from "zod";

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
    async findInStatus(query) {
      const keys: TicketKey[] = [];
      for (const name of (await readdir(ticketsDir).catch(() => [] as string[])).sort()) {
        const key = name.replace(/\.json$/, "");
        if (!name.endsWith(".json") || !TicketKeySchema.safeParse(key).success) continue;
        if (!key.startsWith(`${query.projectKey}-`)) continue;
        const t = await read(key as TicketKey).catch(() => undefined);
        if (t && statusOf(t).toLowerCase() === query.status.toLowerCase()) keys.push(key as TicketKey);
      }
      return keys.slice(0, query.limit);
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
