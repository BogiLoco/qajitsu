import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AdapterError } from "../errors.js";

/** Runs `git` with an argument array (never a shell string; security rules). */
export type GitExec = (
  args: readonly string[],
  options?: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  },
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

/**
 * Default `GitExec` on `child_process.execFile`: no shell, no terminal prompts.
 *
 * @param baseEnv - Environment passed to git, normally `process.env`.
 */
export function createGitExec(baseEnv: Readonly<Record<string, string | undefined>>): GitExec {
  return (args, options = {}) =>
    new Promise((resolve, reject) => {
      execFile(
        "git",
        [...args],
        {
          cwd: options.cwd,
          env: { ...baseEnv, ...options.env, GIT_TERMINAL_PROMPT: "0" },
          maxBuffer: 64 * 1024 * 1024,
          ...(options.signal ? { signal: options.signal } : {}),
        },
        (error, stdout, stderr) => {
          if (error) {
            const failure: Error & { stderr?: string } = error;
            failure.stderr = stderr;
            reject(failure);
          } else resolve({ stdout, stderr });
        },
      );
    });
}

/**
 * Splits an authenticated clone URL into a credential-free URL and git config that sends the
 * credentials as an HTTP header through environment variables, so they never appear in argv,
 * `git remote -v`, the mirror config or error messages (invariant 8).
 *
 * @param cloneUrl - URL possibly carrying `user:password@`.
 */
export function splitCredentials(cloneUrl: string): { url: string; env: Record<string, string> } {
  let parsed: URL;
  try {
    parsed = new URL(cloneUrl);
  } catch {
    return { url: cloneUrl, env: {} };
  }
  if (parsed.username === "" && parsed.password === "") return { url: cloneUrl, env: {} };
  const basic = Buffer.from(
    `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
  ).toString("base64");
  parsed.username = "";
  parsed.password = "";
  return {
    url: parsed.toString(),
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    },
  };
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** Bare mirrors in a cache plus per-run worktrees at exact SHAs (REQ-CTX-04). */
export interface GitRepos {
  /**
   * Creates or incrementally updates the bare mirror of a repository (REQ-CTX-04/AC1).
   *
   * @returns Absolute path of the mirror.
   */
  ensureMirror(hostAlias: string, repoPath: string, cloneUrl: string, signal?: AbortSignal): Promise<string>;
  /**
   * Adds a detached worktree of `sha` at `target` and verifies HEAD (REQ-CTX-04/AC2).
   *
   * @throws {AdapterError} `GIT_SHA_MISSING` when the SHA is not in the mirror even after fetching it.
   */
  addWorktree(
    mirror: string,
    sha: string,
    target: string,
    cloneUrl: string,
    signal?: AbortSignal,
  ): Promise<string>;
  /**
   * The commit `sha` branched from on branch `ref` of the mirror: the version before a change (REQ-VER-11/AC1).
   *
   * @throws {AdapterError} `GIT_SHA_INVALID`, `GIT_REF_INVALID` or `GIT_FAILED`.
   */
  mergeBase(mirror: string, sha: string, ref: string, signal?: AbortSignal): Promise<string>;
}

/**
 * Creates the git repository manager.
 *
 * @param options - Mirror cache directory (default `~/.qa-cache/git`) and git runner.
 * @example
 * const git = createGitRepos({ cacheDir, exec: createGitExec(process.env) });
 * const mirror = await git.ensureMirror("github", "example-org/shop-web", await host.cloneUrl(repo));
 * await git.addWorktree(mirror, change.headSha, ws.path("repos", "web"), cloneUrl);
 */
export function createGitRepos(options: { readonly cacheDir: string; readonly exec: GitExec }): GitRepos {
  const { cacheDir, exec } = options;

  const run = async (
    args: readonly string[],
    what: string,
    env: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<string> => {
    try {
      return (await exec(args, { env, ...(signal ? { signal } : {}) })).stdout;
    } catch (error) {
      if (signal?.aborted) throw error;
      const raw = (error as { stderr?: unknown }).stderr;
      const stderr = (typeof raw === "string" ? raw : "")
        .replace(/Authorization: \S+ \S+/g, "Authorization: ***")
        .trim()
        .slice(0, 500);
      throw new AdapterError("GIT_FAILED", `git ${what} failed.`, { what, stderr });
    }
  };

  return {
    async ensureMirror(hostAlias, repoPath, cloneUrl, signal) {
      if (
        !/^[\w.-]+$/.test(hostAlias) ||
        !/^[\w.-]+(?:\/[\w.-]+)+$/.test(repoPath) ||
        repoPath.includes("..")
      ) {
        throw new AdapterError("GIT_PATH_INVALID", "Invalid host alias or repository path.", {
          hostAlias,
          repoPath,
        });
      }
      const mirror = join(cacheDir, hostAlias, `${repoPath}.git`);
      const { url, env } = splitCredentials(cloneUrl);
      if (await exists(join(mirror, "HEAD"))) {
        await run(["-C", mirror, "remote", "set-url", "origin", url], "remote set-url", {}, signal);
        await run(["-C", mirror, "fetch", "--prune", "origin"], "fetch", env, signal);
      } else {
        await mkdir(dirname(mirror), { recursive: true });
        await run(["clone", "--mirror", "--", url, mirror], "clone --mirror", env, signal);
      }
      return mirror;
    },

    async addWorktree(mirror, sha, target, cloneUrl, signal) {
      if (!SHA.test(sha)) throw new AdapterError("GIT_SHA_INVALID", "Expected a full commit SHA.", { sha });
      const hasSha = async (): Promise<boolean> => {
        try {
          await exec(["-C", mirror, "cat-file", "-e", `${sha}^{commit}`]);
          return true;
        } catch {
          return false;
        }
      };
      if (!(await hasSha())) {
        const { env } = splitCredentials(cloneUrl);
        try {
          await run(["-C", mirror, "fetch", "origin", sha], "fetch <sha>", env, signal);
        } catch {
          // Reported below as GIT_SHA_MISSING with the SHA, which is more useful than the fetch error.
        }
        if (!(await hasSha())) {
          throw new AdapterError("GIT_SHA_MISSING", `Commit ${sha} is not available in the repository.`, {
            sha,
          });
        }
      }
      await mkdir(dirname(target), { recursive: true });
      await run(["-C", mirror, "worktree", "prune"], "worktree prune", {}, signal);
      await run(
        ["-C", mirror, "worktree", "add", "--detach", "--force", target, sha],
        "worktree add",
        {},
        signal,
      );
      const head = (await run(["-C", target, "rev-parse", "HEAD"], "rev-parse", {}, signal)).trim();
      if (head !== sha) {
        throw new AdapterError("GIT_SHA_MISMATCH", "Worktree HEAD differs from the requested SHA.", {
          sha,
          head,
        });
      }
      return target;
    },

    async mergeBase(mirror, sha, ref, signal) {
      if (!SHA.test(sha)) throw new AdapterError("GIT_SHA_INVALID", "Expected a full commit SHA.", { sha });
      if (!/^(?!-)[\w./-]+$/.test(ref) || ref.includes(".."))
        throw new AdapterError("GIT_REF_INVALID", "Invalid branch name.", { ref });
      const base = (
        await run(["-C", mirror, "merge-base", sha, `refs/heads/${ref}`], "merge-base", {}, signal)
      ).trim();
      if (!SHA.test(base))
        throw new AdapterError("GIT_FAILED", "git merge-base returned no commit.", { ref });
      return base;
    },
  };
}
