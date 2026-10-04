import { stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AdapterError,
  mentionsTicketKey,
  type ChangeLocator,
  type ChangeRef,
  type CodeHost,
  type GitExec,
  type TicketKey,
} from "@qajitsu/core";

const REPO = /^[\w.-]+(?:\/[\w.-]+)+$/;
const SHA = /^[0-9a-f]{40}$/;

/**
 * CodeHost over git repositories in a directory: `<root>/<repo path>` (bare or working repos).
 * Discovery matches the ticket key in branch names; there are no PRs, MRs or review comments.
 * Used by the demo-shop and e2e tests so `qj fetch` runs without accounts (REQ-NFR-04).
 *
 * @param config - Host alias and absolute root directory.
 * @param exec - Git runner from `@qajitsu/core`.
 * @example
 * const host = createLocalCodeHost({ alias: "local", root: "/home/qa/.qa-demo/git" }, createGitExec(process.env));
 */
export function createLocalCodeHost(
  config: { readonly alias: string; readonly root: string },
  exec: GitExec,
): CodeHost {
  const dirOf = (repo: string): string => {
    if (!REPO.test(repo) || repo.split("/").includes("..")) {
      throw new AdapterError("LOCAL_REPO_INVALID", "Expected owner/name.", { repo });
    }
    return join(config.root, repo);
  };
  const git = async (repo: string, args: readonly string[]): Promise<string> => {
    try {
      return (await exec(["-C", dirOf(repo), ...args])).stdout;
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("LOCAL_GIT_FAILED", `git ${args[0] ?? ""} failed in ${repo}.`, { repo });
    }
  };
  const defaultBranch = async (repo: string): Promise<string> =>
    (await git(repo, ["symbolic-ref", "--short", "HEAD"])).trim();

  return {
    async check() {
      const ok = await stat(config.root).then(
        (st) => st.isDirectory(),
        () => false,
      );
      return { ok, detail: ok ? `repositories under ${config.root}` : `${config.root} not found` };
    },
    type: "local",
    async findChangesForTicket(key: TicketKey, repos: readonly string[]) {
      const found: ChangeRef[] = [];
      for (const repo of repos) {
        const out = await git(repo, [
          "for-each-ref",
          "--format=%(objectname) %(refname:short)",
          "refs/heads",
        ]);
        for (const line of out.split("\n")) {
          const [sha, name] = line.trim().split(" ");
          if (!sha || !name || !mentionsTicketKey(name, key)) continue;
          found.push({
            host: config.alias,
            repo,
            kind: "branch",
            id: name,
            sourceBranch: name,
            targetBranch: await defaultBranch(repo),
            headSha: sha,
            matchedBy: "branch",
          });
        }
      }
      return found;
    },
    parseChangeUrl(): ChangeLocator | undefined {
      return undefined;
    },
    async resolveChange(locator: ChangeLocator): Promise<ChangeRef> {
      if (locator.kind === "pr" || locator.kind === "mr" || locator.id.startsWith("-")) {
        throw new AdapterError("LOCAL_REF_INVALID", "A local host resolves branches, tags and SHAs only.", {
          ...locator,
        });
      }
      const sha = (
        await git(locator.repo, ["rev-parse", "--verify", "--end-of-options", `${locator.id}^{commit}`])
      ).trim();
      return {
        host: config.alias,
        repo: locator.repo,
        kind: SHA.test(locator.id) ? "sha" : locator.kind,
        id: locator.id,
        ...(locator.kind === "branch" ? { sourceBranch: locator.id } : {}),
        targetBranch: await defaultBranch(locator.repo),
        headSha: sha,
      };
    },
    async getDiff(change: ChangeRef): Promise<string> {
      const base = change.targetBranch ?? (await defaultBranch(change.repo));
      return git(change.repo, ["diff", "--end-of-options", `${base}...${change.headSha}`]);
    },
    getReviewComments() {
      return Promise.resolve([]);
    },
    cloneUrl(repo: string) {
      return Promise.resolve(pathToFileURL(dirOf(repo)).href);
    },
  };
}
