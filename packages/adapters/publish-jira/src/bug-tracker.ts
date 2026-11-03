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
