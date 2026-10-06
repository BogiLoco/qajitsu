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
import { createInstallationTokenProvider } from "./github-app.js";

/** Branch names QAJitsu creates or targets: no `..`, no leading `/`. */
const BRANCH = /^(?!.*\.\.)(?!\/)[\w./-]{1,200}$/;

/** Settings of one GitHub code host from `code_hosts` in `.qa/qa.project.yaml`. */
export interface GitHubConfig {
  /** Alias of the host in the project configuration. */
  readonly alias: string;
  /** Web URL; `https://github.com` by default, the GHES URL otherwise. */
  readonly baseUrl?: string | undefined;
  /** `secret://` reference of a fine-grained token. */
  readonly token?: string | undefined;
  readonly app?:
    { readonly appId: string; readonly installationId: string; readonly privateKey: string } | undefined;
}

const PullSchema = z.object({
  number: z.number(),
  title: z.string(),
  html_url: z.string(),
  body: z.string().nullable().optional(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
});
const BranchSchema = z.object({ name: z.string(), commit: z.object({ sha: z.string() }) });
const CommitSchema = z.object({ sha: z.string() });
const CommentSchema = z.object({
  user: z.object({ login: z.string() }).nullable(),
  body: z.string(),
  path: z.string().optional(),
  line: z.number().nullable().optional(),
});

/** Pages read when listing PRs and branches; discovery looks at the most recently updated items. */
export const GITHUB_MAX_PAGES = 3;

const REPO = /^(?!\.\.?\/)[\w.-]+\/(?!\.\.?$)[\w.-]+$/;

/** Turns an access probe into a doctor result; the error code only, never response bodies or tokens. */
const probe = async (call: () => Promise<unknown>, ok: string): Promise<{ ok: boolean; detail: string }> => {
  try {
    await call();
    return { ok: true, detail: ok };
  } catch (error) {
    return { ok: false, detail: error instanceof AdapterError ? error.code : "unreachable" };
  }
};

const IssueCommentSchema = z.object({
  id: z.number().int(),
  body: z.string().default(""),
  user: z.object({ login: z.string(), type: z.string().optional() }).nullable().default(null),
});

/**
 * Creates the GitHub CodeHost for github.com or GitHub Enterprise Server (REQ-CTX-02).
 *
 * @param config - Host alias, optional GHES URL and token or GitHub App credentials.
 * @param deps - Injected fetch, logger, clock and secret resolver.
 * @example
 * const github = createGitHubCodeHost({ alias: "github", token: "secret://env/GITHUB_TOKEN" }, deps);
 * const changes = await github.findChangesForTicket(key, ["example-org/shop-web"]);
 */
export function createGitHubCodeHost(
  config: GitHubConfig,
  deps: AdapterDeps & { readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void> },
): CodeHost {
  const web = new URL(config.baseUrl ?? "https://github.com");
  const apiBase = web.hostname === "github.com" ? "https://api.github.com" : `${web.origin}/api/v3`;
  const common = {
    service: "GITHUB",
    baseUrl: apiBase,
    fetch: deps.fetch,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  };
  const ghHeaders = { "x-github-api-version": "2022-11-28", "user-agent": "qajitsu" };
  let token: () => Promise<string>;
  if (config.app) {
    const { appId, installationId, privateKey } = config.app;
    token = createInstallationTokenProvider({
      appId,
      installationId,
      privateKey: () => deps.resolveSecret(privateKey),
      http: createHttpClient({ ...common, headers: () => Promise.resolve(ghHeaders) }),
      now: deps.now,
      registerSecret: deps.registerSecret,
    });
  } else if (config.token) {
    const ref = config.token;
    token = () => deps.resolveSecret(ref);
  } else {
    throw new AdapterError("GITHUB_AUTH_MISSING", "GitHub host needs a token or a GitHub App.", {
      alias: config.alias,
    });
  }
  const http = createHttpClient({
    ...common,
    headers: async () => ({ ...ghHeaders, authorization: `Bearer ${await token()}` }),
  });

  const checkRepo = (repo: string): string => {
    if (!REPO.test(repo)) throw new AdapterError("GITHUB_REPO_INVALID", "Expected owner/name.", { repo });
    return repo;
  };

  const toChange = (
    repo: string,
    pr: z.infer<typeof PullSchema>,
    matchedBy?: "title" | "branch",
  ): ChangeRef => ({
    host: config.alias,
    repo,
    kind: "pr",
    id: String(pr.number),
    title: pr.title,
    ...(pr.body ? { description: pr.body } : {}),
    sourceBranch: pr.head.ref,
    targetBranch: pr.base.ref,
    headSha: pr.head.sha,
    url: pr.html_url,
    ...(matchedBy ? { matchedBy } : {}),
  });

  const pages = async <T extends z.ZodType>(path: string, schema: T, signal?: AbortSignal) => {
    const items: z.infer<T>[] = [];
    for (let page = 1; ; page += 1) {
      if (page > GITHUB_MAX_PAGES) {
        deps.logger.warn(
          { path: path.split("?")[0], pages: GITHUB_MAX_PAGES },
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

  const defaultBranch = async (repo: string, signal?: AbortSignal): Promise<string> =>
    (await http.json(`/repos/${repo}`, z.object({ default_branch: z.string() }), { signal })).default_branch;

  return {
    type: "github",
    check: (signal) =>
      probe(
        () => http.json("/rate_limit", z.object({}).loose(), { signal }),
        "GitHub reachable, credentials accepted",
      ),
    async findChangesForTicket(key: TicketKey, repos: readonly string[], signal?: AbortSignal) {
      const found: ChangeRef[] = [];
      for (const repo of repos.map(checkRepo)) {
        const pulls = await pages(
          `/repos/${repo}/pulls?state=all&sort=updated&direction=desc`,
          PullSchema,
          signal,
        );
        const prBranches = new Set<string>();
        for (const pr of pulls) {
          const inTitle = mentionsTicketKey(pr.title, key);
          const inBranch = mentionsTicketKey(pr.head.ref, key);
          if (!inTitle && !inBranch) continue;
          prBranches.add(pr.head.ref);
          found.push(toChange(repo, pr, inTitle ? "title" : "branch"));
        }
        const branches = await pages(`/repos/${repo}/branches`, BranchSchema, signal);
        for (const branch of branches) {
          if (!mentionsTicketKey(branch.name, key) || prBranches.has(branch.name)) continue;
          found.push({
            host: config.alias,
            repo,
            kind: "branch",
            id: branch.name,
            sourceBranch: branch.name,
            headSha: branch.commit.sha,
            url: `${web.origin}/${repo}/tree/${branch.name}`,
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
      const m = /^\/([\w.-]+\/[\w.-]+)\/(pull|tree|commit)\/(.+?)\/?$/.exec(
        decodeURIComponent(parsed.pathname),
      );
      if (!m?.[1] || !m[2] || !m[3]) return undefined;
      const kind = m[2] === "pull" ? "pr" : m[2] === "tree" ? "branch" : "sha";
      const id = kind === "pr" ? (/^\d+/.exec(m[3])?.[0] ?? m[3]) : m[3];
      return { repo: m[1], kind, id };
    },

    async resolveChange(locator: ChangeLocator, signal?: AbortSignal): Promise<ChangeRef> {
      const repo = checkRepo(locator.repo);
      if (locator.kind === "pr" || locator.kind === "mr") {
        if (!/^\d+$/.test(locator.id))
          throw new AdapterError("GITHUB_PR_INVALID", "PR id must be a number.", { ...locator });
        return toChange(repo, await http.json(`/repos/${repo}/pulls/${locator.id}`, PullSchema, { signal }));
      }
      const commit = await http.json(
        `/repos/${repo}/commits/${encodeURIComponent(locator.id)}`,
        CommitSchema,
        {
          signal,
        },
      );
      return {
        host: config.alias,
        repo,
        kind: locator.kind,
        id: locator.id,
        ...(locator.kind === "branch" ? { sourceBranch: locator.id } : {}),
        targetBranch: await defaultBranch(repo, signal),
        headSha: commit.sha,
        url: `${web.origin}/${repo}/${locator.kind === "branch" ? "tree" : "commit"}/${locator.id}`,
      };
    },

    async getDiff(change: ChangeRef, signal?: AbortSignal): Promise<string> {
      const repo = checkRepo(change.repo);
      const accept = { accept: "application/vnd.github.diff" };
      if (change.kind === "pr")
        return http.text(`/repos/${repo}/pulls/${change.id}`, { headers: accept, signal });
      const base = change.targetBranch ?? (await defaultBranch(repo, signal));
      return http.text(`/repos/${repo}/compare/${encodeURIComponent(base)}...${change.headSha}`, {
        headers: accept,
        signal,
      });
    },

    async getReviewComments(change: ChangeRef, signal?: AbortSignal): Promise<readonly ReviewComment[]> {
      if (change.kind !== "pr") return [];
      const repo = checkRepo(change.repo);
      const inline = await pages(`/repos/${repo}/pulls/${change.id}/comments`, CommentSchema, signal);
      const conversation = await pages(`/repos/${repo}/issues/${change.id}/comments`, CommentSchema, signal);
      return [...inline, ...conversation].map((c) => ({
        author: c.user?.login ?? "ghost",
        body: c.body,
        ...(c.path ? { path: c.path } : {}),
        ...(typeof c.line === "number" ? { line: c.line } : {}),
      }));
    },

    /**
     * Downloads a GitHub Actions artifact (zip) built for exactly this commit (REQ-ENV-06/AC1): the
     * newest successful workflow run with `head_sha` that has a non-expired artifact of that name. The
     * archive URL redirects to GitHub's blob storage, which is fetched without our token.
     *
     * @throws {AdapterError} `GITHUB_ARTIFACT_NOT_FOUND`.
     */
    async downloadArtifact(
      repo: string,
      sha: string,
      name: string,
      signal?: AbortSignal,
    ): Promise<Uint8Array> {
      checkRepo(repo);
      if (!/^[0-9a-f]{7,64}$/.test(sha))
        throw new AdapterError("GITHUB_SHA_INVALID", "Expected a commit SHA.", {});
      const runs = await http.json(
        `/repos/${repo}/actions/runs?head_sha=${sha}&status=success&per_page=20`,
        z.object({ workflow_runs: z.array(z.object({ id: z.number().int() })) }),
        { signal },
      );
      for (const run of runs.workflow_runs) {
        const { artifacts } = await http.json(
          `/repos/${repo}/actions/runs/${String(run.id)}/artifacts?per_page=100`,
          z.object({
            artifacts: z.array(z.object({ id: z.number().int(), name: z.string(), expired: z.boolean() })),
          }),
          { signal },
        );
        const hit = artifacts.find((a) => a.name === name && !a.expired);
        if (hit)
          return http.bytes(`/repos/${repo}/actions/artifacts/${String(hit.id)}/zip`, {
            signal,
            anonymousCrossOriginRedirect: true,
            anonymousRedirectHosts: ["blob.core.windows.net", "actions.githubusercontent.com"],
            maxBytes: 500_000_000,
          });
      }
      throw new AdapterError(
        "GITHUB_ARTIFACT_NOT_FOUND",
        `No artifact '${name}' from a successful run of ${sha.slice(0, 12)}.`,
        {
          repo,
          name,
        },
      );
    },

    async upsertComment(target, body, marker, signal) {
      const repo = checkRepo(target.repo);
      if (!/^\d+$/.test(target.id)) throw new AdapterError("GITHUB_PR_INVALID", "Expected a PR number.", {});
      const comments = await pages(`/repos/${repo}/issues/${target.id}/comments`, IssueCommentSchema, signal);
      // Only a comment written by our own identity is updated: anyone can paste the marker into theirs.
      const me = await http.json("/user", z.object({ login: z.string() }), { signal }).then(
        (u) => u.login,
        () => undefined,
      );
      const mine = comments.find(
        (c) => c.body.includes(marker) && (me === undefined ? c.user?.type === "Bot" : c.user?.login === me),
      );
      const json = { "content-type": "application/json" };
      const saved = mine
        ? await http.json(
            `/repos/${repo}/issues/comments/${String(mine.id)}`,
            z.object({ html_url: z.string() }),
            {
              method: "PATCH",
              headers: json,
              body: JSON.stringify({ body }),
              signal,
            },
          )
        : await http.json(`/repos/${repo}/issues/${target.id}/comments`, z.object({ html_url: z.string() }), {
            method: "POST",
            headers: json,
            body: JSON.stringify({ body }),
            signal,
          });
      return { url: saved.html_url };
    },

    async openChangeRequest(request, signal) {
      const repo = checkRepo(request.repo);
      for (const branch of [request.sourceBranch, request.targetBranch])
        if (!BRANCH.test(branch)) throw new AdapterError("GITHUB_BRANCH_INVALID", "Invalid branch name.", {});
      const Pull = z.object({ number: z.number().int(), html_url: z.string() });
      try {
        const pr = await http.json(`/repos/${repo}/pulls`, Pull, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: request.title,
            head: request.sourceBranch,
            base: request.targetBranch,
            body: request.body,
          }),
          signal,
        });
        return { id: String(pr.number), url: pr.html_url, created: true };
      } catch (error) {
        // 422: a pull request for this branch already exists; return it instead of failing.
        if (!(error instanceof AdapterError) || error.context["status"] !== 422) throw error;
        const owner = repo.split("/")[0] ?? "";
        const [open] = await http.json(
          `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${request.sourceBranch}`)}`,
          z.array(Pull),
          { signal },
        );
        if (!open) throw error;
        return { id: String(open.number), url: open.html_url, created: false };
      }
    },

    async setCommitStatus(repo, sha, status, signal) {
      checkRepo(repo);
      if (!/^[0-9a-f]{40}$/.test(sha))
        throw new AdapterError("GITHUB_SHA_INVALID", "Expected a full commit SHA.", {});
      await http.json(`/repos/${repo}/statuses/${sha}`, z.object({}).loose(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          state: status.state,
          context: status.context,
          description: status.description.slice(0, 140),
          ...(status.targetUrl ? { target_url: status.targetUrl } : {}),
        }),
        signal,
      });
    },

    async cloneUrl(repo: string): Promise<string> {
      const url = new URL(`${web.origin}/${checkRepo(repo)}.git`);
      url.username = "x-access-token";
      url.password = await token();
      return url.toString();
    },
  };
}
