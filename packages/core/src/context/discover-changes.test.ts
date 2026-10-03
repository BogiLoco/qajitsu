import { describe, expect, it } from "vitest";
import { parseProjectConfig } from "../config/project-config.js";
import { TicketKeySchema } from "../identifiers.js";
import type { ChangeLocator, ChangeRef, CodeHost } from "../interfaces/code-host.js";
import type { Ticket } from "../interfaces/ticket-source.js";
import { discoverChanges } from "./discover-changes.js";

const sha = (c: string): string => c.repeat(40);
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const config = parseProjectConfig({
  project: "shop",
  jira: { type: "file", tickets_dir: "t", project_key: "SHOP" },
  code_hosts: {
    github: { type: "github", token: "secret://env/GH" },
    gitlab: { type: "gitlab", base_url: "https://gitlab.example.com", token: "secret://env/GL" },
  },
  repos: {
    web: { host: "github", path: "example-org/shop-web" },
    backend: { host: "gitlab", path: "shop/backend" },
    e2e: { host: "github", path: "example-org/shop-e2e", role: "tests" },
  },
});

const ticket = (links: Ticket["developmentLinks"] = []): Ticket => ({
  key: TicketKeySchema.parse("SHOP-482"),
  summary: "s",
  description: "",
  issueType: "Story",
  status: "Ready",
  labels: [],
  components: [],
  acceptanceCriteria: [],
  comments: [],
  linkedKeys: [],
  attachments: [],
  developmentLinks: links,
});

/** Fake host: `prefix` is the URL origin, `found` what search returns. */
const fakeHost = (
  type: string,
  prefix: string,
  found: ChangeRef[] = [],
): CodeHost & { searched: string[][] } => {
  const searched: string[][] = [];
  return {
    type,
    searched,
    findChangesForTicket: (_key, repos) => {
      searched.push([...repos]);
      return Promise.resolve(found.filter((f) => repos.includes(f.repo)));
    },
    parseChangeUrl: (url): ChangeLocator | undefined => {
      if (!url.startsWith(prefix)) return undefined;
      const m = /^\/(.+?)\/(?:-\/)?(?:pull|merge_requests)\/(\d+)$/.exec(url.slice(prefix.length));
      return m?.[1] && m[2] ? { repo: m[1], kind: type === "github" ? "pr" : "mr", id: m[2] } : undefined;
    },
    resolveChange: (l) =>
      Promise.resolve({
        host: type,
        repo: l.repo,
        kind: l.kind,
        id: l.id,
        headSha: l.kind === "sha" ? l.id : sha("a"),
        url: `${prefix}/${l.repo}/${l.id}`,
      }),
    getDiff: () => Promise.resolve(""),
    getReviewComments: () => Promise.resolve([]),
    cloneUrl: () => Promise.resolve(""),
  };
};

const pr = (
  repo: string,
  id: string,
  matchedBy: "title" | "branch",
  kind: ChangeRef["kind"] = "pr",
  src?: string,
): ChangeRef => ({
  host: "github",
  repo,
  kind,
  id,
  headSha: sha(id.length > 1 ? "c" : id),
  matchedBy,
  url: `https://github.com/${repo}/pull/${id}`,
  ...(src ? { sourceBranch: src } : {}),
});

describe("discoverChanges (REQ-CTX-03)", () => {
  it("REQ-CTX-03/AC1 + REQ-CTX-02/AC4: uses dev panel links across GitHub and GitLab repos of one project, skipping undeclared repos", async () => {
    const github = fakeHost("github", "https://github.com");
    const gitlab = fakeHost("gitlab", "https://gitlab.example.com");
    const result = await discoverChanges({
      ticket: ticket([
        { url: "https://github.com/example-org/shop-web/pull/12", kind: "pr" },
        { url: "https://gitlab.example.com/shop/backend/-/merge_requests/7", kind: "mr" },
        { url: "https://github.com/other-org/x/pull/1", kind: "pr" },
      ]),
      config,
      codeHosts: { github, gitlab },
      logger,
    });
    expect(result.strategy).toBe("jira_dev_panel");
    expect(result.changes.map((c) => [c.repoAlias, c.change.kind, c.change.id])).toEqual([
      ["web", "pr", "12"],
      ["backend", "mr", "7"],
    ]);
    expect(result.skippedLinks).toEqual(["https://github.com/other-org/x/pull/1"]);
    expect(github.searched).toEqual([]);
  });

  it("REQ-CTX-03/AC2: falls back to the branch strategy, then title, searching only app repos", async () => {
    const github = fakeHost("github", "https://github.com", [pr("example-org/shop-web", "1", "title")]);
    const gitlab = fakeHost("gitlab", "https://gitlab.example.com");
    const result = await discoverChanges({ ticket: ticket(), config, codeHosts: { github, gitlab }, logger });
    expect(result.strategy).toBe("ticket_key_in_title");
    expect(github.searched).toEqual([["example-org/shop-web"]]);

    const byBranch = fakeHost("github", "https://github.com", [
      pr("example-org/shop-web", "1", "title", "pr", "feature/SHOP-482"),
      pr("example-org/shop-web", "2", "branch"),
    ]);
    const second = await discoverChanges({
      ticket: ticket(),
      config,
      codeHosts: { github: byBranch, gitlab },
      logger,
    });
    expect(second.strategy).toBe("ticket_key_in_branch");
    expect(second.changes[0]?.change.id).toBe("1");
    expect(second.changes[0]?.alternatives.map((a) => a.id)).toEqual(["2"]);
  });

  it("REQ-CTX-03/AC4: a change spanning several repositories yields one entry per repository; PRs win over branches", async () => {
    const github = fakeHost("github", "https://github.com", [
      pr("example-org/shop-web", "feature/SHOP-482", "branch", "branch"),
      pr("example-org/shop-web", "5", "branch"),
    ]);
    const gitlab = fakeHost("gitlab", "https://gitlab.example.com", [
      { host: "gitlab", repo: "shop/backend", kind: "mr", id: "9", headSha: sha("d"), matchedBy: "branch" },
    ]);
    const result = await discoverChanges({ ticket: ticket(), config, codeHosts: { github, gitlab }, logger });
    expect(result.changes.map((c) => [c.repoAlias, c.change.id])).toEqual([
      ["web", "5"],
      ["backend", "9"],
    ]);
  });

  it("REQ-CTX-03/AC3: --pr/--mr URLs and --ref override discovery", async () => {
    const github = fakeHost("github", "https://github.com", [pr("example-org/shop-web", "1", "title")]);
    const gitlab = fakeHost("gitlab", "https://gitlab.example.com");
    const result = await discoverChanges({
      ticket: ticket([{ url: "https://github.com/example-org/shop-web/pull/99", kind: "pr" }]),
      config,
      codeHosts: { github, gitlab },
      overrides: {
        urls: ["https://gitlab.example.com/shop/backend/-/merge_requests/3"],
        refs: [`web=${sha("e")}`],
      },
      logger,
    });
    expect(result.strategy).toBe("manual");
    expect(result.changes.map((c) => [c.repoAlias, c.change.kind, c.change.headSha])).toEqual([
      ["backend", "mr", sha("a")],
      ["web", "sha", sha("e")],
    ]);
  });

  it("REQ-CTX-03/AC3: rejects ambiguous or unknown overrides", async () => {
    const codeHosts = {
      github: fakeHost("github", "https://github.com"),
      gitlab: fakeHost("gitlab", "https://gitlab.example.com"),
    };
    const run = (overrides: { urls?: string[]; refs?: string[] }) =>
      discoverChanges({ ticket: ticket(), config, codeHosts, overrides, logger });
    await expect(run({ refs: ["main"] })).rejects.toMatchObject({ code: "CHANGE_OVERRIDE_INVALID" });
    await expect(run({ refs: ["nope=main"] })).rejects.toMatchObject({ code: "CHANGE_OVERRIDE_INVALID" });
    await expect(run({ refs: ["web=--upload-pack=x"] })).rejects.toMatchObject({
      code: "CHANGE_OVERRIDE_INVALID",
    });
    await expect(run({ urls: ["https://github.com/other/x/pull/1"] })).rejects.toMatchObject({
      code: "CHANGE_OVERRIDE_INVALID",
    });
  });

  it("REQ-CTX-03/AC5: nothing found stops with a clear message and never uses the default branch", async () => {
    const codeHosts = {
      github: fakeHost("github", "https://github.com"),
      gitlab: fakeHost("gitlab", "https://gitlab.example.com"),
    };
    await expect(discoverChanges({ ticket: ticket(), config, codeHosts, logger })).rejects.toMatchObject({
      code: "CHANGE_NOT_FOUND",
      message: expect.stringContaining("--pr <url>") as unknown,
      context: { tried: ["jira_dev_panel", "ticket_key_in_branch", "ticket_key_in_title"] },
    });
  });

  it("a missing code host instance is a configuration error", async () => {
    await expect(
      discoverChanges({
        ticket: ticket(),
        config,
        codeHosts: { github: fakeHost("github", "https://github.com") },
        logger,
      }),
    ).rejects.toMatchObject({ code: "CODE_HOST_MISSING" });
  });
});
