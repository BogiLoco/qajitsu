import {
  AdapterError,
  createHttpClient,
  mentionsTicketKey,
  type AdapterDeps,
  type ChangeLocator,
  type ChangeRef,
  type CodeHost,
  type ReviewComment,
  type TicketKey,
} from "@qajitsu/core";
import { z } from "zod";

/** Settings of one GitLab code host from `code_hosts` in `.qa/qa.project.yaml`. */
export interface GitLabConfig {
  /** Alias of the host in the project configuration. */
  readonly alias: string;
  /** Web URL; `https://gitlab.com` by default, the self-managed URL otherwise. */
  readonly baseUrl?: string | undefined;
  /** `secret://` reference of a project or group access token with `read_api` and `read_repository`. */
  readonly token: string;
}

const MergeRequestSchema = z.object({
  iid: z.number(),
  title: z.string(),
  description: z.string().nullable().optional(),
  web_url: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
  sha: z.string(),
});
const BranchSchema = z.object({ name: z.string(), commit: z.object({ id: z.string() }) });
const FileDiffSchema = z.object({
  old_path: z.string(),
  new_path: z.string(),
  new_file: z.boolean(),
  renamed_file: z.boolean(),
  deleted_file: z.boolean(),
  diff: z.string(),
});
const NoteSchema = z.object({
  author: z.object({ username: z.string() }),
  body: z.string(),
  system: z.boolean(),
  position: z
    .object({ new_path: z.string().optional(), new_line: z.number().nullable().optional() })
    .nullable()
    .optional(),
});

/** Pages read when listing MRs, branches, diffs and notes. */
export const GITLAB_MAX_PAGES = 3;

const PROJECT = /^[\w.-]+(?:\/[\w.-]+)+$/;

/**
 * Renders GitLab per-file diffs as one unified diff with `diff --git` headers, renames,
 * new and deleted files, so downstream tools see the same format as GitHub.
 *
 * @param files - Items of `/merge_requests/:iid/diffs` or `/repository/compare`.
 */
export function toUnifiedDiff(files: readonly z.infer<typeof FileDiffSchema>[]): string {
  return files
    .map((f) => {
      const lines = [`diff --git a/${f.old_path} b/${f.new_path}`];
      if (f.new_file) lines.push("new file mode 100644");
      if (f.deleted_file) lines.push("deleted file mode 100644");
      if (f.renamed_file) lines.push(`rename from ${f.old_path}`, `rename to ${f.new_path}`);
      if (f.diff !== "") {
        lines.push(`--- ${f.new_file ? "/dev/null" : `a/${f.old_path}`}`);
        lines.push(`+++ ${f.deleted_file ? "/dev/null" : `b/${f.new_path}`}`);
        lines.push(f.diff.replace(/\n$/, ""));
      }
      return lines.join("\n");
    })
    .join("\n")
    .concat(files.length > 0 ? "\n" : "");
}

/**
 * Creates the GitLab CodeHost for gitlab.com or GitLab self-managed (REQ-CTX-02).
 *
 * @param config - Host alias, optional self-managed URL and token reference.
 * @param deps - Injected fetch, logger, clock and secret resolver.
 * @example
 * const gitlab = createGitLabCodeHost({ alias: "gitlab", baseUrl: "https://gitlab.example.com", token: "secret://env/GITLAB_TOKEN" }, deps);
 */
export function createGitLabCodeHost(
  config: GitLabConfig,
  deps: AdapterDeps & { readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void> },
): CodeHost {
  const web = new URL(config.baseUrl ?? "https://gitlab.com");
  const http = createHttpClient({
    service: "GITLAB",
    baseUrl: `${web.origin}/api/v4`,
    fetch: deps.fetch,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    headers: async () => ({ "private-token": await deps.resolveSecret(config.token) }),
  });

  const project = (path: string): string => {
    if (!PROJECT.test(path) || path.split("/").includes("..")) {
      throw new AdapterError("GITLAB_PROJECT_INVALID", "Expected group/project.", { repo: path });
    }
    return `/projects/${encodeURIComponent(path)}`;
  };

  const pages = async <T extends z.ZodType>(path: string, schema: T, signal?: AbortSignal) => {
    const items: z.infer<T>[] = [];
    for (let page = 1; ; page += 1) {
      if (page > GITLAB_MAX_PAGES) {
        deps.logger.warn(
          { path: path.split("?")[0], pages: GITLAB_MAX_PAGES },
          "Listing truncated at the page limit; older items were not searched",
        );
        break;
      }
      const sep = path.includes("?") ? "&" : "?";
      const batch = await http.json(`${path}${sep}per_page=100&page=${String(page)}`, z.array(schema), {
        signal,
      });
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items;
  };

  const toChange = (
    repo: string,
    mr: z.infer<typeof MergeRequestSchema>,
    matchedBy?: "title" | "branch",
  ): ChangeRef => ({
    host: config.alias,
    repo,
    kind: "mr",
    id: String(mr.iid),
    title: mr.title,
    ...(mr.description ? { description: mr.description } : {}),
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    headSha: mr.sha,
    url: mr.web_url,
    ...(matchedBy ? { matchedBy } : {}),
  });

  const defaultBranch = async (repo: string, signal?: AbortSignal): Promise<string> =>
    (await http.json(project(repo), z.object({ default_branch: z.string() }), { signal })).default_branch;

  return {
    type: "gitlab",
    async findChangesForTicket(key: TicketKey, repos: readonly string[], signal?: AbortSignal) {
      const found: ChangeRef[] = [];
      for (const repo of repos) {
        const base = project(repo);
        const mrs = await pages(
          `${base}/merge_requests?state=all&order_by=updated_at`,
          MergeRequestSchema,
          signal,
        );
        const mrBranches = new Set<string>();
        for (const mr of mrs) {
          const inTitle = mentionsTicketKey(mr.title, key);
          const inBranch = mentionsTicketKey(mr.source_branch, key);
          if (!inTitle && !inBranch) continue;
          mrBranches.add(mr.source_branch);
          found.push(toChange(repo, mr, inTitle ? "title" : "branch"));
        }
        const branches = await pages(
          `${base}/repository/branches?search=${encodeURIComponent(key)}`,
          BranchSchema,
          signal,
        );
        for (const branch of branches) {
          if (!mentionsTicketKey(branch.name, key) || mrBranches.has(branch.name)) continue;
          found.push({
            host: config.alias,
            repo,
            kind: "branch",
            id: branch.name,
            sourceBranch: branch.name,
            headSha: branch.commit.id,
            url: `${web.origin}/${repo}/-/tree/${branch.name}`,
            matchedBy: "branch",
          });
        }
      }
      return found;
    },

    parseChangeUrl(url: string): ChangeLocator | undefined {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return undefined;
      }
      if (parsed.origin !== web.origin) return undefined;
      const m = /^\/(.+?)\/-\/(merge_requests|tree|commit)\/(.+?)\/?$/.exec(
        decodeURIComponent(parsed.pathname),
      );
      if (!m?.[1] || !m[2] || !m[3]) return undefined;
      const kind = m[2] === "merge_requests" ? "mr" : m[2] === "tree" ? "branch" : "sha";
      const id = kind === "mr" ? (/^\d+/.exec(m[3])?.[0] ?? m[3]) : m[3];
      return { repo: m[1], kind, id };
    },

    async resolveChange(locator: ChangeLocator, signal?: AbortSignal): Promise<ChangeRef> {
      const base = project(locator.repo);
      if (locator.kind === "mr" || locator.kind === "pr") {
        if (!/^\d+$/.test(locator.id))
          throw new AdapterError("GITLAB_MR_INVALID", "MR iid must be a number.", { ...locator });
        return toChange(
          locator.repo,
          await http.json(`${base}/merge_requests/${locator.id}`, MergeRequestSchema, { signal }),
        );
      }
      const commit = await http.json(
        `${base}/repository/commits/${encodeURIComponent(locator.id)}`,
        z.object({ id: z.string() }),
        { signal },
      );
      return {
        host: config.alias,
        repo: locator.repo,
        kind: locator.kind,
        id: locator.id,
        ...(locator.kind === "branch" ? { sourceBranch: locator.id } : {}),
        targetBranch: await defaultBranch(locator.repo, signal),
        headSha: commit.id,
        url: `${web.origin}/${locator.repo}/-/${locator.kind === "branch" ? "tree" : "commit"}/${locator.id}`,
      };
    },

    async getDiff(change: ChangeRef, signal?: AbortSignal): Promise<string> {
      const base = project(change.repo);
      if (change.kind === "mr") {
        return toUnifiedDiff(
          await pages(`${base}/merge_requests/${change.id}/diffs`, FileDiffSchema, signal),
        );
      }
      const from = change.targetBranch ?? (await defaultBranch(change.repo, signal));
      const query = new URLSearchParams({ from, to: change.headSha, straight: "false" });
      const compare = await http.json(
        `${base}/repository/compare?${query.toString()}`,
        z.object({ diffs: z.array(FileDiffSchema) }),
        {
          signal,
        },
      );
      return toUnifiedDiff(compare.diffs);
    },

    async getReviewComments(change: ChangeRef, signal?: AbortSignal): Promise<readonly ReviewComment[]> {
      if (change.kind !== "mr") return [];
      const notes = await pages(
        `${project(change.repo)}/merge_requests/${change.id}/notes?sort=asc`,
        NoteSchema,
        signal,
      );
      return notes
        .filter((n) => !n.system)
        .map((n) => ({
          author: n.author.username,
          body: n.body,
          ...(n.position?.new_path ? { path: n.position.new_path } : {}),
          ...(typeof n.position?.new_line === "number" ? { line: n.position.new_line } : {}),
        }));
    },

    async cloneUrl(repo: string): Promise<string> {
      project(repo);
      const url = new URL(`${web.origin}/${repo}.git`);
      url.username = "oauth2";
      url.password = await deps.resolveSecret(config.token);
      return url.toString();
    },
  };
}
