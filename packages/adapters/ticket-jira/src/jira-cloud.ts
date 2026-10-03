import {
  AdapterError,
  TicketKeySchema,
  createHttpClient,
  type AdapterDeps,
  type DevelopmentLink,
  type Ticket,
  type TicketKey,
  type TicketSource,
} from "@qajitsu/core";
import { z } from "zod";
import { AdfNodeSchema, adfToMarkdown, extractAcceptanceCriteria } from "./adf.js";

/** Settings of the Jira Cloud ticket source, taken from `jira` in `.qa/qa.project.yaml`. */
export interface JiraCloudConfig {
  readonly baseUrl: string;
  /** `secret://` reference of the account e-mail. */
  readonly email: string;
  /** `secret://` reference of the API token. */
  readonly token: string;
  /** Custom field holding acceptance criteria, e.g. `customfield_10042`. */
  readonly acceptanceCriteriaField?: string | undefined;
}

const RichText = z.union([AdfNodeSchema, z.string(), z.null()]).optional();

const IssueSchema = z.object({
  id: z.string(),
  key: z.string(),
  fields: z
    .object({
      summary: z.string(),
      issuetype: z.object({ name: z.string() }).optional(),
      status: z.object({ name: z.string() }).optional(),
      labels: z.array(z.string()).default([]),
      components: z.array(z.object({ name: z.string() })).default([]),
      description: RichText,
      comment: z
        .object({
          comments: z.array(
            z.object({
              author: z.object({ displayName: z.string() }).optional(),
              created: z.string(),
              body: RichText,
            }),
          ),
        })
        .default({ comments: [] }),
      issuelinks: z
        .array(
          z.object({
            outwardIssue: z.object({ key: z.string() }).optional(),
            inwardIssue: z.object({ key: z.string() }).optional(),
          }),
        )
        .default([]),
      attachment: z
        .array(z.object({ filename: z.string(), mimeType: z.string(), content: z.string() }))
        .default([]),
    })
    .loose(),
});

const DevStatusSchema = z.object({
  detail: z
    .array(
      z.object({
        pullRequests: z
          .array(
            z.object({
              name: z.string().optional(),
              url: z.string(),
              source: z.object({ branch: z.string() }).optional(),
              destination: z.object({ branch: z.string() }).optional(),
            }),
          )
          .default([]),
        branches: z.array(z.object({ name: z.string(), url: z.string() })).default([]),
      }),
    )
    .default([]),
});

/** Code host applications queried in the development panel (GitHub for Jira, GitLab for Jira). */
export const DEV_PANEL_APPLICATIONS = ["GitHub", "GitLab"] as const;

const linkKind = (url: string): "pr" | "mr" => (url.includes("/merge_requests/") ? "mr" : "pr");

/**
 * Creates the Jira Cloud TicketSource (REST v3; REQ-CTX-01). The development panel uses the
 * internal `dev-status` API; when it is unavailable the ticket is still returned and discovery
 * falls back to the next strategy (REQ-CTX-03).
 *
 * @param config - Base URL, secret references and optional acceptance criteria field.
 * @param deps - Injected fetch, logger, clock and secret resolver.
 * @example
 * const source = createJiraCloudTicketSource({ baseUrl, email: "secret://env/JIRA_EMAIL", token: "secret://env/JIRA_TOKEN" }, deps);
 * const ticket = await source.getTicket(TicketKeySchema.parse("SHOP-482"));
 */
export function createJiraCloudTicketSource(
  config: JiraCloudConfig,
  deps: AdapterDeps & { readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void> },
): TicketSource {
  const http = createHttpClient({
    service: "JIRA",
    baseUrl: config.baseUrl,
    fetch: deps.fetch,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    headers: async () => {
      const email = await deps.resolveSecret(config.email);
      const token = await deps.resolveSecret(config.token);
      return { authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` };
    },
  });

  const developmentLinks = async (issueId: string, signal?: AbortSignal): Promise<DevelopmentLink[]> => {
    const links: DevelopmentLink[] = [];
    for (const app of DEV_PANEL_APPLICATIONS) {
      for (const dataType of ["pullrequest", "branch"] as const) {
        const query = new URLSearchParams({ issueId, applicationType: app, dataType });
        try {
          const status = await http.json(
            `/rest/dev-status/latest/issue/detail?${query.toString()}`,
            DevStatusSchema,
            {
              signal,
            },
          );
          for (const detail of status.detail) {
            for (const pr of dataType === "pullrequest" ? detail.pullRequests : []) {
              links.push({
                url: pr.url,
                kind: linkKind(pr.url),
                ...(pr.name ? { title: pr.name } : {}),
                ...(pr.source ? { sourceBranch: pr.source.branch } : {}),
                ...(pr.destination ? { targetBranch: pr.destination.branch } : {}),
              });
            }
            for (const branch of dataType === "branch" ? detail.branches : []) {
              links.push({ url: branch.url, kind: "branch", sourceBranch: branch.name });
            }
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          deps.logger.warn(
            { app, dataType, code: error instanceof AdapterError ? error.code : "UNKNOWN" },
            "Jira development panel unavailable; change discovery falls back to the next strategy",
          );
        }
      }
    }
    const seen = new Set<string>();
    return links.filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true)));
  };

  return {
    async getTicket(key: TicketKey, signal?: AbortSignal): Promise<Ticket> {
      const safeKey = TicketKeySchema.parse(key);
      const fields = [
        "summary",
        "issuetype",
        "status",
        "labels",
        "components",
        "description",
        "comment",
        "issuelinks",
        "attachment",
        ...(config.acceptanceCriteriaField ? [config.acceptanceCriteriaField] : []),
      ];
      const issue = await http.json(`/rest/api/3/issue/${safeKey}?fields=${fields.join(",")}`, IssueSchema, {
        signal,
      });
      const description = adfToMarkdown(issue.fields.description);
      let acceptanceCriteria = extractAcceptanceCriteria(description);
      if (config.acceptanceCriteriaField) {
        const raw = (issue.fields as Record<string, unknown>)[config.acceptanceCriteriaField];
        const parsed = RichText.safeParse(raw);
        const fieldText = parsed.success ? adfToMarkdown(parsed.data) : "";
        if (fieldText.trim() !== "") acceptanceCriteria = extractAcceptanceCriteria(fieldText, true);
      }
      return {
        key: safeKey,
        summary: issue.fields.summary,
        description,
        issueType: issue.fields.issuetype?.name ?? "Unknown",
        status: issue.fields.status?.name ?? "Unknown",
        labels: issue.fields.labels,
        components: issue.fields.components.map((c) => c.name),
        acceptanceCriteria,
        comments: issue.fields.comment.comments.map((c) => ({
          author: c.author?.displayName ?? "unknown",
          body: adfToMarkdown(c.body),
          created: c.created,
        })),
        linkedKeys: issue.fields.issuelinks.flatMap((l) =>
          [l.outwardIssue?.key, l.inwardIssue?.key].filter((k): k is string => k !== undefined),
        ),
        attachments: issue.fields.attachment.map((a) => ({
          name: a.filename,
          mimeType: a.mimeType,
          url: a.content,
        })),
        developmentLinks: await developmentLinks(issue.id, signal),
      };
    },
  };
}
