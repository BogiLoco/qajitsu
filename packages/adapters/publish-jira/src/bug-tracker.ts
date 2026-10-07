import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AdapterError,
  createHttpClient,
  type AdapterDeps,
  type BugDraft,
  type BugMatch,
  type BugTracker,
} from "@qajitsu/core";
import { z } from "zod";
import type { JiraPublisherConfig } from "./jira-publisher.js";

const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const quoteJql = (value: string): string => `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
/** Jira text search treats these as operators; words are plain letters and digits. */
const safeWord = (w: string): string | undefined => (/^[\p{L}\p{N}]{3,30}$/u.test(w) ? w : undefined);

/**
 * Jira as the bug tracker (REQ-PUB-07): JQL search for open bugs, issue creation (ADF on Cloud, wiki markup on Data
 * Center) and "Relates" links. Only called after the user confirmed.
 *
 * @param config - Flavor, base URL and credentials, as for publishing.
 * @param deps - Injected fetch, logger, clock and secret resolver.
 */
export function createJiraBugTracker(
  config: Pick<JiraPublisherConfig, "flavor" | "baseUrl" | "email" | "token">,
  deps: AdapterDeps,
): BugTracker {
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
  const browse = (key: string): string => `${new URL(config.baseUrl).origin}/browse/${key}`;
  const json = { "content-type": "application/json" };
  const Issue = z.object({
    key: z.string(),
    fields: z.object({ summary: z.string(), status: z.object({ name: z.string() }).optional() }),
  });
  return {
    async findSimilar(search, signal): Promise<readonly BugMatch[]> {
      if (!/^[A-Z][A-Z0-9_]+$/.test(search.project))
        throw new AdapterError("JIRA_PROJECT_INVALID", "Invalid Jira project key.", {});
      const words = [
        ...new Set(search.words.map(safeWord).filter((w): w is string => w !== undefined)),
      ].slice(0, 6);
      if (words.length === 0) return [];
      const jql = [
        `project = ${quoteJql(search.project)}`,
        "issuetype = Bug",
        "statusCategory != Done",
        `(${words.map((w) => `summary ~ ${quoteJql(w)}`).join(" OR ")})`,
        ...(search.components.length > 0
          ? [`component in (${search.components.map(quoteJql).join(", ")})`]
          : []),
      ].join(" AND ");
      const query = new URLSearchParams({
        jql: `${jql} ORDER BY updated DESC`,
        fields: "summary,status",
        maxResults: "10",
      });
      const page = await http.json(
        `${api}/${cloud ? "search/jql" : "search"}?${query.toString()}`,
        z.object({ issues: z.array(Issue) }),
        {
          signal,
        },
      );
      return page.issues.map((i) => ({
        key: i.key,
        summary: i.fields.summary,
        status: i.fields.status?.name ?? "?",
        url: browse(i.key),
      }));
    },
    async createBug(draft: BugDraft, signal) {
      const created = await http.json(`${api}/issue`, z.object({ key: z.string() }), {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          fields: {
            project: { key: draft.project },
            issuetype: { name: "Bug" },
            summary: draft.summary,
            description: cloud ? draft.description.adf : draft.description.wiki,
            labels: [...draft.labels],
            ...(draft.components.length > 0
              ? { components: draft.components.map((name) => ({ name })) }
              : {}),
          },
        }),
        signal,
      });
      return { key: created.key, url: browse(created.key) };
    },
    async link(from, to, signal) {
      if (!KEY.test(from) || !KEY.test(to))
        throw new AdapterError("JIRA_KEY_INVALID", "Invalid issue key.", {});
      await http.text(`${api}/issueLink`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          type: { name: "Relates" },
          inwardIssue: { key: from },
          outwardIssue: { key: to },
        }),
        signal,
      });
    },
  };
}

const FileIssue = z.object({
  key: z.string(),
  type: z.string().default("Story"),
  status: z.string().default("Unknown"),
  summary: z.string(),
  components: z.array(z.string()).default([]),
});

/**
 * Bug tracker for `jira.type: file` (demo, offline, tests): searches the ticket files for open bugs and writes new
 * bugs and links as JSON files into `outDir` instead of sending them.
 *
 * @param ticketsDir - Directory of `<KEY>.json` tickets.
 * @param outDir - Where created bugs and links are written.
 */
export function createFileBugTracker(ticketsDir: string, outDir: string): BugTracker {
  return {
    async findSimilar(search) {
      const words = search.words.map((w) => w.toLowerCase());
      const out: BugMatch[] = [];
      for (const name of (await readdir(ticketsDir).catch(() => [] as string[]))
        .filter((n) => n.endsWith(".json"))
        .sort()) {
        const parsed = FileIssue.safeParse(JSON.parse(await readFile(join(ticketsDir, name), "utf8")));
        if (!parsed.success) continue;
        const t = parsed.data;
        if (t.type.toLowerCase() !== "bug" || /^(done|closed|resolved)$/i.test(t.status)) continue;
        if (!t.key.startsWith(`${search.project}-`)) continue;
        if (!words.some((w) => t.summary.toLowerCase().includes(w))) continue;
        out.push({ key: t.key, summary: t.summary, status: t.status });
      }
      return out;
    },
    async createBug(draft) {
      await mkdir(outDir, { recursive: true });
      const existing = (await readdir(outDir)).filter((n) => /^[A-Z].*-\d+\.json$/.test(n)).length;
      const key = `${draft.project}-${String(9001 + existing)}`;
      await writeFile(join(outDir, `${key}.json`), `${JSON.stringify({ key, ...draft }, null, 2)}\n`);
      return { key, url: `file://${join(outDir, `${key}.json`)}` };
    },
    async link(from, to) {
      if (!KEY.test(from) || !KEY.test(to))
        throw new AdapterError("JIRA_KEY_INVALID", "Invalid issue key.", {});
      await mkdir(outDir, { recursive: true });
      await writeFile(
        join(outDir, `link-${from}-${to}.json`),
        `${JSON.stringify({ type: "Relates", from, to })}\n`,
      );
    },
  };
}
