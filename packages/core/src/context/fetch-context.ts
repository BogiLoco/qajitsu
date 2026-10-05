import { writeFile } from "node:fs/promises";
import { ConfigError, QajitsuError } from "../errors.js";
import type { ProjectConfig } from "../config/project-config.js";
import type { EventLog } from "../events/event-log.js";
import type { GitRepos } from "../git/git-repos.js";
import type { TicketKey } from "../identifiers.js";
import type { CodeHost } from "../interfaces/code-host.js";
import type { Logger } from "../interfaces/common.js";
import type { TicketSource } from "../interfaces/ticket-source.js";
import type { RunWorkspace } from "../workspace/run-workspace.js";
import { discoverChanges, type Discovery, type DiscoveryOverrides } from "./discover-changes.js";
import { renderTicketMarkdown } from "./ticket-snapshot.js";

const ORCHESTRATOR = { kind: "system", name: "orchestrator" } as const;

/** Summary of the fetch stage. */
export interface FetchResult {
  readonly discovery: Discovery;
  /** Repository alias → analysed SHA (REQ-CTX-04/AC3). */
  readonly shas: Readonly<Record<string, string>>;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Stage `fetch` (REQ-CTX-01..04): ticket snapshot, change discovery, diffs and review comments,
 * worktrees at the exact SHA and SHAs in `run.json`. Deterministic code, no agent (invariant 9).
 *
 * @param options - Workspace, ticket key, config, adapters, git manager, event log and ports.
 * @returns Discovery and SHAs per repository.
 * @throws {QajitsuError} Any adapter, git or configuration failure; the run is marked `failed`
 *   and the CLI exits with code 3 (REQ-CTX-01/AC5).
 */
export async function fetchContext(options: {
  readonly workspace: RunWorkspace;
  readonly ticket: TicketKey;
  readonly config: ProjectConfig;
  readonly ticketSource: TicketSource;
  readonly codeHosts: Readonly<Record<string, CodeHost>>;
  readonly git: GitRepos;
  readonly events: EventLog;
  readonly logger: Logger;
  readonly overrides?: DiscoveryOverrides;
  /** Asked when nothing is found and the session is interactive; returns PR/MR URLs or `<repo>=<ref>`. */
  readonly askForChange?: (message: string) => Promise<readonly string[]>;
  readonly now: () => Date;
  readonly signal?: AbortSignal;
}): Promise<FetchResult> {
  const { workspace: ws, config, codeHosts, git, events, logger, signal } = options;
  await ws.update({ status: "running", stage: "fetch" });
  events.emit("fetch", ORCHESTRATOR, "stage.start");
  try {
    const ticket = await options.ticketSource.getTicket(options.ticket, signal);
    await writeFile(ws.path("ticket", "ticket.json"), json(ticket), "utf8");
    await writeFile(ws.path("ticket", "ticket.md"), renderTicketMarkdown(ticket), "utf8");
    events.emit("fetch", ORCHESTRATOR, "ticket.fetched", {
      key: ticket.key,
      criteria: ticket.acceptanceCriteria.length,
      developmentLinks: ticket.developmentLinks.length,
    });

    let discovery: Discovery;
    const base = { ticket, config, codeHosts, logger, ...(signal ? { signal } : {}) };
    try {
      discovery = await discoverChanges({
        ...base,
        ...(options.overrides ? { overrides: options.overrides } : {}),
      });
    } catch (error) {
      if (!(error instanceof ConfigError) || error.code !== "CHANGE_NOT_FOUND" || !options.askForChange)
        throw error;
      const answers = await options.askForChange(error.message);
      if (answers.length === 0) throw error;
      events.emit("fetch", { kind: "user", name: "cli" }, "change.provided", { answers });
      discovery = await discoverChanges({
        ...base,
        overrides: {
          urls: answers.filter((a) => /^https?:\/\//.test(a)),
          refs: answers.filter((a) => !/^https?:\/\//.test(a)),
        },
      });
    }
    events.emit("fetch", ORCHESTRATOR, "changes.discovered", {
      strategy: discovery.strategy,
      changes: discovery.changes.map((c) => ({
        repo: c.repoAlias,
        kind: c.change.kind,
        id: c.change.id,
        sha: c.change.headSha,
      })),
      skippedLinks: discovery.skippedLinks,
    });

    const shas: Record<string, string> = {};
    const repos: Record<
      string,
      { host: string; path: string; sha: string; change?: string; strategy?: string; role?: "tests" }
    > = {};
    for (const { repoAlias, change } of discovery.changes) {
      const repo = config.repos[repoAlias];
      const host = codeHosts[change.host] ?? (repo ? codeHosts[repo.host] : undefined);
      if (!repo || !host)
        throw new ConfigError("REPO_UNKNOWN", `Repository '${repoAlias}' is not configured.`, { repoAlias });
      const diff = await host.getDiff(change, signal);
      await writeFile(ws.path("repos", `${repoAlias}.diff`), diff, "utf8");
      const comments = await host.getReviewComments(change, signal);
      await writeFile(ws.path("repos", `${repoAlias}.change.json`), json({ change, comments }), "utf8");
      const cloneUrl = await host.cloneUrl(repo.path);
      const mirror = await git.ensureMirror(repo.host, repo.path, cloneUrl, signal);
      await git.addWorktree(mirror, change.headSha, ws.path("repos", repoAlias), cloneUrl, signal);
      shas[repoAlias] = change.headSha;
      repos[repoAlias] = {
        host: repo.host,
        path: repo.path,
        sha: change.headSha,
        change: change.url ?? `${change.kind}:${change.id}`,
        strategy: discovery.strategy,
      };
      events.emit("fetch", ORCHESTRATOR, "repo.checked_out", { repo: repoAlias, sha: change.headSha });
    }
    // REQ-CTX-06/AC1: the tests repository is checked out like any other repo, at its default branch; change
    // discovery never looks at it. It is context for the planner and the author, not part of the analysed change.
    for (const [alias, repo] of Object.entries(config.repos)) {
      if (repo.role !== "tests" || repos[alias] !== undefined) continue;
      const host = codeHosts[repo.host];
      if (!host)
        throw new ConfigError(
          "REPO_UNKNOWN",
          `Code host '${repo.host}' of repository '${alias}' is not configured.`,
          {
            repoAlias: alias,
          },
        );
      const head = await host.resolveChange(
        { repo: repo.path, kind: "branch", id: repo.default_ref },
        signal,
      );
      const cloneUrl = await host.cloneUrl(repo.path);
      const mirror = await git.ensureMirror(repo.host, repo.path, cloneUrl, signal);
      await git.addWorktree(mirror, head.headSha, ws.path("repos", alias), cloneUrl, signal);
      repos[alias] = { host: repo.host, path: repo.path, sha: head.headSha, role: "tests" };
      events.emit("fetch", ORCHESTRATOR, "tests_repo.checked_out", {
        repo: alias,
        ref: repo.default_ref,
        sha: head.headSha,
      });
    }
    await writeFile(
      ws.path("repos", "changes.json"),
      json({
        strategy: discovery.strategy,
        skippedLinks: discovery.skippedLinks,
        changes: discovery.changes,
      }),
      "utf8",
    );
    await ws.update({
      status: "completed",
      stage: "fetch",
      repos,
      checkpoints: [...ws.record.checkpoints, { stage: "fetch", at: options.now().toISOString() }],
    });
    events.emit("fetch", ORCHESTRATOR, "stage.end", { status: "ok" });
    return { discovery, shas };
  } catch (error) {
    events.emit("fetch", ORCHESTRATOR, "stage.end", {
      status: "error",
      code: error instanceof QajitsuError ? error.code : "UNEXPECTED",
      message: error instanceof Error ? error.message : String(error),
    });
    try {
      await ws.update({ status: "failed" });
    } catch (bookkeeping) {
      logger.error(
        { cause: bookkeeping instanceof Error ? bookkeeping.message : String(bookkeeping) },
        "Could not mark the run failed",
      );
    }
    throw error;
  }
}
