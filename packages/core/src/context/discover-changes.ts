import { ConfigError } from "../errors.js";
import { mentionsTicketKey } from "../identifiers.js";
import type { ProjectConfig } from "../config/project-config.js";
import type { ChangeLocator, ChangeRef, CodeHost } from "../interfaces/code-host.js";
import type { Logger } from "../interfaces/common.js";
import type { Ticket } from "../interfaces/ticket-source.js";

/** Strategy that produced the changes of a run (REQ-CTX-03). */
export type DiscoveryStrategy = "manual" | ProjectConfig["change_discovery"][number];

/** One repository of the change, keyed by its alias in `.qa/qa.project.yaml` (REQ-CTX-03/AC4). */
export interface DiscoveredChange {
  readonly repoAlias: string;
  readonly change: ChangeRef;
  /** Other candidates for the same repository that were not chosen. */
  readonly alternatives: readonly ChangeRef[];
}

/** Result of change discovery. */
export interface Discovery {
  readonly strategy: DiscoveryStrategy;
  readonly changes: readonly DiscoveredChange[];
  /** Development panel links that point to repositories not declared in the project. */
  readonly skippedLinks: readonly string[];
}

/** Manual overrides from the command line (REQ-CTX-03/AC3). */
export interface DiscoveryOverrides {
  /** PR or MR URLs (`--pr`, `--mr`). */
  readonly urls?: readonly string[];
  /** `--ref <ref>` or `--ref <repoAlias>=<ref>`: branch, tag or SHA. */
  readonly refs?: readonly string[];
}

const kindRank = (c: ChangeRef): number => (c.kind === "pr" || c.kind === "mr" ? 0 : 1);

/**
 * Finds the repositories and exact commits that implement a ticket (REQ-CTX-03). Manual overrides
 * win; otherwise strategies run in the configured order and the first one with results is used.
 * It never falls back to a default branch.
 *
 * @param options - Ticket snapshot, project config, code hosts by alias and overrides.
 * @returns The chosen strategy and one change per repository.
 * @throws {ConfigError} `CHANGE_NOT_FOUND` when nothing matches, `CHANGE_OVERRIDE_INVALID` for bad overrides.
 */
export async function discoverChanges(options: {
  readonly ticket: Ticket;
  readonly config: ProjectConfig;
  readonly codeHosts: Readonly<Record<string, CodeHost>>;
  readonly overrides?: DiscoveryOverrides;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
}): Promise<Discovery> {
  const { ticket, config, codeHosts, overrides = {}, logger, signal } = options;
  const appRepos = Object.entries(config.repos).filter(([, r]) => r.role === "app");

  const hostOf = (alias: string): CodeHost => {
    const host = codeHosts[alias];
    if (!host)
      throw new ConfigError("CODE_HOST_MISSING", `Code host '${alias}' is not available.`, { alias });
    return host;
  };
  const aliasFor = (hostAlias: string, repoPath: string): string | undefined =>
    appRepos.find(([, r]) => r.host === hostAlias && r.path.toLowerCase() === repoPath.toLowerCase())?.[0];

  /** Finds the code host and repo alias for a URL among declared repositories. */
  const locate = (
    url: string,
  ): { hostAlias: string; repoAlias: string; locator: ChangeLocator } | undefined => {
    for (const [hostAlias] of Object.entries(config.code_hosts)) {
      const locator = codeHosts[hostAlias]?.parseChangeUrl(url);
      if (!locator) continue;
      const repoAlias = aliasFor(hostAlias, locator.repo);
      if (repoAlias) return { hostAlias, repoAlias, locator };
    }
    return undefined;
  };

  const group = (found: readonly { repoAlias: string; change: ChangeRef }[]): DiscoveredChange[] => {
    const byRepo = new Map<string, ChangeRef[]>();
    for (const { repoAlias, change } of found)
      byRepo.set(repoAlias, [...(byRepo.get(repoAlias) ?? []), change]);
    return [...byRepo.entries()].map(([repoAlias, list]) => {
      const sorted = [...list].sort((a, b) => kindRank(a) - kindRank(b));
      const [change, ...alternatives] = sorted as [ChangeRef, ...ChangeRef[]];
      if (alternatives.length > 0) {
        logger.warn(
          {
            repo: repoAlias,
            chosen: change.url ?? change.id,
            alternatives: alternatives.map((a) => a.url ?? a.id),
          },
          "Several changes match the ticket in one repository; using the first, override with --pr/--mr/--ref",
        );
      }
      return { repoAlias, change, alternatives };
    });
  };

  // Strategy 3: manual overrides (REQ-CTX-03/AC3).
  if ((overrides.urls?.length ?? 0) > 0 || (overrides.refs?.length ?? 0) > 0) {
    const found: { repoAlias: string; change: ChangeRef }[] = [];
    for (const url of overrides.urls ?? []) {
      const hit = locate(url);
      if (!hit) {
        throw new ConfigError(
          "CHANGE_OVERRIDE_INVALID",
          `${url} does not belong to a repository in .qa/qa.project.yaml.`,
          {
            url,
          },
        );
      }
      found.push({
        repoAlias: hit.repoAlias,
        change: await hostOf(hit.hostAlias).resolveChange(hit.locator, signal),
      });
    }
    for (const spec of overrides.refs ?? []) {
      const eq = spec.indexOf("=");
      const [alias, ref] = eq > 0 ? [spec.slice(0, eq), spec.slice(eq + 1)] : [undefined, spec];
      const candidates = alias === undefined ? appRepos : appRepos.filter(([a]) => a === alias);
      const target = candidates.length === 1 ? candidates[0] : undefined;
      if (!target || ref === "" || ref.startsWith("-")) {
        throw new ConfigError(
          "CHANGE_OVERRIDE_INVALID",
          alias === undefined
            ? "--ref needs <repo>=<ref> when the project has several repositories."
            : `Unknown repository '${alias}' in --ref.`,
          { ref: spec, repos: appRepos.map(([a]) => a) },
        );
      }
      const [repoAlias, repo] = target;
      const kind = /^[0-9a-f]{40}$/.test(ref) ? "sha" : "branch";
      found.push({
        repoAlias,
        change: await hostOf(repo.host).resolveChange({ repo: repo.path, kind, id: ref }, signal),
      });
    }
    return { strategy: "manual", changes: group(found), skippedLinks: [] };
  }

  const tried: string[] = [];
  const skippedLinks: string[] = [];
  let candidatesByHost: { repoAlias: string; change: ChangeRef }[] | undefined;
  const searchHosts = async (): Promise<{ repoAlias: string; change: ChangeRef }[]> => {
    if (candidatesByHost) return candidatesByHost;
    const all: { repoAlias: string; change: ChangeRef }[] = [];
    for (const hostAlias of new Set(appRepos.map(([, r]) => r.host))) {
      const paths = appRepos.filter(([, r]) => r.host === hostAlias).map(([, r]) => r.path);
      for (const change of await hostOf(hostAlias).findChangesForTicket(ticket.key, paths, signal)) {
        const repoAlias = aliasFor(hostAlias, change.repo);
        if (repoAlias) all.push({ repoAlias, change });
      }
    }
    candidatesByHost = all;
    return all;
  };

  for (const strategy of config.change_discovery) {
    tried.push(strategy);
    let found: { repoAlias: string; change: ChangeRef }[] = [];
    if (strategy === "jira_dev_panel") {
      for (const link of ticket.developmentLinks) {
        const hit = locate(link.url);
        if (!hit) {
          skippedLinks.push(link.url);
          continue;
        }
        found.push({
          repoAlias: hit.repoAlias,
          change: await hostOf(hit.hostAlias).resolveChange(hit.locator, signal),
        });
      }
    } else if (strategy === "ticket_key_in_branch") {
      found = (await searchHosts()).filter(
        (c) => c.change.matchedBy === "branch" || mentionsTicketKey(c.change.sourceBranch ?? "", ticket.key),
      );
    } else {
      found = (await searchHosts()).filter((c) => c.change.matchedBy === "title");
    }
    if (found.length > 0) {
      const unique = found.filter(
        (f, i) =>
          found.findIndex(
            (g) =>
              g.repoAlias === f.repoAlias &&
              g.change.headSha === f.change.headSha &&
              g.change.kind === f.change.kind &&
              g.change.id === f.change.id,
          ) === i,
      );
      return { strategy, changes: group(unique), skippedLinks };
    }
  }

  throw new ConfigError(
    "CHANGE_NOT_FOUND",
    `No PR/MR or branch for ${ticket.key} was found (tried: ${tried.join(", ")}). ` +
      "Pass --pr <url>, --mr <url> or --ref <repo>=<branch|tag|sha>; the default branch is never tested silently.",
    { ticket: ticket.key, tried, skippedLinks },
  );
}
