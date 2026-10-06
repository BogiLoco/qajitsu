import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  AdapterError,
  createHttpClient,
  type AdapterDeps,
  type DocumentSource,
  type RemoteDocument,
} from "@qajitsu/core";
import { z } from "zod";
import { AdfNodeSchema, adfToMarkdown, wikiToMarkdown } from "./adf.js";
import type { JiraCloudConfig } from "./jira-cloud.js";

/** Resolved bugs read from one source at most (newest first). */
export const MAX_BUGS = 1_000;
const PAGE = 100;

const RichText = z.union([AdfNodeSchema, z.string(), z.null()]).optional();
const ListedSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string(),
    updated: z.string(),
    components: z.array(z.object({ name: z.string() })).default([]),
  }),
});
const BugSchema = z.object({
  key: z.string(),
  fields: z
    .object({
      summary: z.string(),
      description: RichText,
      components: z.array(z.object({ name: z.string() })).default([]),
      resolution: z.object({ name: z.string() }).nullish(),
      resolutiondate: z.string().nullish(),
      fixVersions: z.array(z.object({ name: z.string() })).default([]),
      comment: z
        .object({
          comments: z.array(
            z.object({ author: z.object({ displayName: z.string() }).optional(), body: RichText }),
          ),
        })
        .default({ comments: [] }),
    })
    .loose(),
});

/** Component tags: `component-<slug>` (REQ-KNOW-12/AC2), so `search_docs` can narrow to one area. */
export const componentTag = (name: string): string =>
  `component-${
    name
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "none"
  }`;

const quoteJql = (value: string): string => `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** Markdown of a resolved bug for the knowledge base: what broke, where, how it was resolved, the last comments. */
function bugMarkdown(
  key: string,
  summary: string,
  details: {
    components: readonly string[];
    resolution?: string | undefined;
    resolvedAt?: string | undefined;
    fixVersions: readonly string[];
    description: string;
    comments: readonly string[];
  },
): string {
  return [
    `# ${key} ${summary}`,
    "",
    `Components: ${details.components.join(", ") || "none"}`,
    `Resolution: ${details.resolution ?? "unknown"}${details.resolvedAt ? ` (${details.resolvedAt.slice(0, 10)})` : ""}`,
    ...(details.fixVersions.length > 0 ? [`Fix versions: ${details.fixVersions.join(", ")}`] : []),
    "",
    "## Description",
    details.description || "(none)",
    ...(details.comments.length > 0 ? ["", "## Comments", ...details.comments.map((c) => `- ${c}`)] : []),
  ].join("\n");
}

/**
 * Resolved bugs of a Jira project as a knowledge source for regression ideas (REQ-KNOW-12/AC2): issues of type Bug
 * in a done status, optionally of one component, newest first. Listing carries the update time as version, so a
 * sync loads only bugs that changed. Cloud (REST v3, `/search/jql`) and Data Center (REST v2).
 *
 * @param config - Jira connection (as for tickets) plus the project key and an optional component.
 * @param deps - Injected fetch, logger, clock and secret resolver.
 */
export function createJiraBugSource(
  config: JiraCloudConfig & { readonly projectKey: string; readonly component?: string | undefined },
  deps: AdapterDeps,
): DocumentSource {
  if (!/^[A-Z][A-Z0-9_]+$/.test(config.projectKey))
    throw new AdapterError("JIRA_PROJECT_INVALID", "Invalid Jira project key.", {});
  const dc = config.flavor === "datacenter";
  const api = dc ? "/rest/api/2" : "/rest/api/3";
  const http = createHttpClient({
    service: "JIRA",
    baseUrl: config.baseUrl,
    fetch: deps.fetch,
    headers: async () => {
      const token = await deps.resolveSecret(config.token);
      deps.registerSecret(token);
      if (dc) return { authorization: `Bearer ${token}` };
      if (config.email === undefined)
        throw new AdapterError("JIRA_AUTH_MISSING", "Jira Cloud needs an e-mail and a token.", {});
      const email = await deps.resolveSecret(config.email);
      return { authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` };
    },
  });
  const jql = [
    `project = ${quoteJql(config.projectKey)}`,
    "issuetype = Bug",
    "statusCategory = Done",
    ...(config.component === undefined ? [] : [`component = ${quoteJql(config.component)}`]),
  ].join(" AND ");
  const query = (extra: Record<string, string>): string =>
    new URLSearchParams({
      jql: `${jql} ORDER BY updated DESC`,
      fields: "summary,updated,components",
      maxResults: String(PAGE),
      ...extra,
    }).toString();
  const toDocument = (issue: z.infer<typeof ListedSchema>): RemoteDocument => ({
    id: issue.key,
    title: issue.fields.summary,
    version: issue.fields.updated,
    modifiedAt: new Date(issue.fields.updated).toISOString(),
    tags: issue.fields.components.map((c) => componentTag(c.name)),
  });
  const toText = (value: z.infer<typeof RichText>): string =>
    dc && typeof value === "string" ? wikiToMarkdown(value) : adfToMarkdown(value);
  return {
    async list(signal) {
      const out: RemoteDocument[] = [];
      if (dc) {
        for (let startAt = 0; out.length < MAX_BUGS; startAt += PAGE) {
          const page = await http.json(
            `${api}/search?${query({ startAt: String(startAt) })}`,
            z.object({ issues: z.array(ListedSchema) }),
            { signal },
          );
          out.push(...page.issues.map(toDocument));
          if (page.issues.length < PAGE) break;
        }
      } else {
        let token: string | undefined;
        do {
          const page = await http.json(
            `${api}/search/jql?${query(token ? { nextPageToken: token } : {})}`,
            z.object({ issues: z.array(ListedSchema), nextPageToken: z.string().optional() }),
            { signal },
          );
          out.push(...page.issues.map(toDocument));
          token = page.nextPageToken;
        } while (token !== undefined && out.length < MAX_BUGS);
      }
      return out.slice(0, MAX_BUGS);
    },
    async load(document, signal) {
      if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(document.id))
        throw new AdapterError("JIRA_KEY_INVALID", "Invalid issue key.", {});
      const bug = await http.json(
        `${api}/issue/${document.id}?fields=summary,description,components,resolution,resolutiondate,fixVersions,comment`,
        BugSchema,
        { signal },
      );
      const f = bug.fields;
      return {
        format: "markdown",
        text: bugMarkdown(bug.key, f.summary, {
          components: f.components.map((c) => c.name),
          resolution: f.resolution?.name,
          resolvedAt: f.resolutiondate ?? undefined,
          fixVersions: f.fixVersions.map((v) => v.name),
          description: toText(f.description),
          comments: f.comment.comments
            .slice(-5)
            .map(
              (c) =>
                `${c.author?.displayName ?? "someone"}: ${toText(c.body).replace(/\s+/g, " ").slice(0, 500)}`,
            ),
        }),
      };
    },
  };
}

const FileBugSchema = z.object({
  key: z.string(),
  type: z.string().default("Story"),
  status: z.string().default("Unknown"),
  summary: z.string(),
  description: z.string().default(""),
  components: z.array(z.string()).default([]),
  updated: z.string().optional(),
  resolution: z.string().optional(),
  comments: z.array(z.object({ author: z.string(), body: z.string() })).default([]),
});

const DONE = /^(done|closed|resolved|fixed)$/i;

/**
 * Resolved bugs from ticket files (`jira.type: file`): the same source for offline demos and tests
 * (REQ-KNOW-12/AC2).
 *
 * @param dir - Directory of `<KEY>.json` tickets.
 */
export function createFileBugSource(
  dir: string,
  options: { readonly component?: string | undefined } = {},
): DocumentSource {
  const read = async (): Promise<z.infer<typeof FileBugSchema>[]> => {
    const out: z.infer<typeof FileBugSchema>[] = [];
    for (const name of (await readdir(dir)).filter((n) => n.endsWith(".json")).sort()) {
      const parsed = FileBugSchema.safeParse(JSON.parse(await readFile(join(dir, name), "utf8")));
      if (!parsed.success) continue;
      const t = parsed.data;
      if (t.type.toLowerCase() !== "bug" || !DONE.test(t.status)) continue;
      if (options.component !== undefined && !t.components.includes(options.component)) continue;
      out.push(t);
    }
    return out;
  };
  return {
    async list() {
      return (await read()).map((t) => ({
        id: t.key,
        title: t.summary,
        version: t.updated ?? `${t.status}:${String(t.description.length)}`,
        modifiedAt: t.updated ?? new Date(0).toISOString(),
        tags: t.components.map(componentTag),
      }));
    },
    async load(document) {
      const t = (await read()).find((x) => x.key === document.id);
      if (!t) throw new AdapterError("JIRA_ISSUE_NOT_FOUND", `${document.id} is not a resolved bug.`, {});
      return {
        format: "markdown",
        text: bugMarkdown(t.key, t.summary, {
          components: t.components,
          resolution: t.resolution ?? t.status,
          fixVersions: [],
          description: t.description,
          comments: t.comments.slice(-5).map((c) => `${c.author}: ${c.body}`),
        }),
      };
    },
  };
}
