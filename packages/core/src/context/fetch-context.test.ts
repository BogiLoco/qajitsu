import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseProjectConfig } from "../config/project-config.js";
import { createEventLog, parseEventLines } from "../events/event-log.js";
import { createGitExec, createGitRepos } from "../git/git-repos.js";
import { TicketKeySchema } from "../identifiers.js";
import type { CodeHost } from "../interfaces/code-host.js";
import type { Ticket, TicketSource } from "../interfaces/ticket-source.js";
import { createRunWorkspace, openRunWorkspace } from "../workspace/run-workspace.js";
import { fetchContext } from "./fetch-context.js";
import { readTicketSnapshot } from "./ticket-snapshot.js";

const exec = createGitExec({ PATH: process.env["PATH"] ?? "", HOME: tmpdir() });
const key = TicketKeySchema.parse("DEMO-1");
const now = (): Date => new Date("2026-10-03T10:46:00Z");
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const config = parseProjectConfig({
  project: "demo",
  jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
  code_hosts: { local: { type: "github", token: "secret://env/T" } },
  repos: { shop: { host: "local", path: "demo-org/demo-shop" } },
});

const ticket: Ticket = {
  key,
  summary: "Cart total",
  description: "Desc",
  issueType: "Story",
  status: "Ready for QA",
  labels: ["cart"],
  components: ["api"],
  acceptanceCriteria: ["Total rounded once"],
  comments: [{ author: "po", body: "note", created: "2026-09-30" }],
  linkedKeys: ["DEMO-2"],
  attachments: [{ name: "a.png", mimeType: "image/png", url: "https://jira.example.com/a" }],
  developmentLinks: [],
};

describe("fetchContext (REQ-CTX-01..04)", () => {
  let dir: string;
  let origin: string;
  let sha: string;
  let fetches: number;
  let source: TicketSource;
  let host: CodeHost;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "qj-fetch-"));
    origin = join(dir, "origin");
    await exec(["init", "-q", "-b", "main", origin]);
    await writeFile(join(origin, "cart.ts"), "export const total = 1;\n");
    await exec(["add", "."], { cwd: origin });
    await exec(["-c", "user.name=qa", "-c", "user.email=qa@example.com", "commit", "-qm", "DEMO-1 cart"], {
      cwd: origin,
    });
    sha = (await exec(["rev-parse", "HEAD"], { cwd: origin })).stdout.trim();
    fetches = 0;
    source = {
      getTicket: () => {
        fetches += 1;
        return Promise.resolve(ticket);
      },
    };
    host = {
      type: "github",
      findChangesForTicket: (_k, repos) =>
        Promise.resolve(
          repos.map((repo) => ({
            host: "local",
            repo,
            kind: "pr" as const,
            id: "12",
            headSha: sha,
            matchedBy: "title" as const,
            url: "https://github.com/demo-org/demo-shop/pull/12",
          })),
        ),
      parseChangeUrl: () => undefined,
      resolveChange: () => Promise.reject(new Error("unused")),
      getDiff: () => Promise.resolve("diff --git a/cart.ts b/cart.ts\n"),
      getReviewComments: () => Promise.resolve([{ author: "rev", body: "ok" }]),
      cloneUrl: () => Promise.resolve(pathToFileURL(origin).href),
    };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = async (overrides: Partial<Parameters<typeof fetchContext>[0]> = {}) => {
    const ws = await createRunWorkspace({ root: join(dir, "runs"), ticket: key, now, random: () => 0 });
    const lines: string[] = [];
    const events = createEventLog({
      ticket: key,
      run: ws.runId,
      write: (l) => lines.push(l),
      now,
      mask: (v) => v,
    });
    const git = createGitRepos({ cacheDir: join(dir, "cache"), exec });
    const promise = fetchContext({
      workspace: ws,
      ticket: key,
      config,
      ticketSource: source,
      codeHosts: { local: host },
      git,
      events,
      logger,
      now,
      ...overrides,
    });
    return { ws, lines, promise };
  };

  it("REQ-CTX-01/AC2 + REQ-CTX-04/AC2-3: writes ticket snapshot, diff, worktree and SHA in run.json", async () => {
    const { ws, lines, promise } = await run();
    const result = await promise;
    expect(result.shas).toEqual({ shop: sha });
    expect(await readTicketSnapshot(ws.path("ticket", "ticket.json"))).toEqual(ticket);
    expect(await readFile(ws.path("ticket", "ticket.md"), "utf8")).toContain("1. Total rounded once");
    expect(await readFile(ws.path("repos", "shop.diff"), "utf8")).toContain("diff --git");
    expect(await readFile(ws.path("repos", "shop", "cart.ts"), "utf8")).toContain("total");
    const changes = JSON.parse(await readFile(ws.path("repos", "changes.json"), "utf8")) as {
      strategy: string;
    };
    expect(changes.strategy).toBe("ticket_key_in_title");
    const record = (await openRunWorkspace(ws.root, key, ws.runId)).record;
    expect(record.repos["shop"]).toMatchObject({ sha, strategy: "ticket_key_in_title" });
    expect(record.status).toBe("completed");
    expect(record.checkpoints).toEqual([{ stage: "fetch", at: "2026-10-03T10:46:00.000Z" }]);
    const names = parseEventLines(lines.join("")).events.map((e) => e.event);
    expect(names).toEqual([
      "stage.start",
      "ticket.fetched",
      "changes.discovered",
      "repo.checked_out",
      "stage.end",
    ]);
    expect(fetches).toBe(1);
  });

  it("REQ-CTX-06/AC1: the tests repository is checked out at its default branch, marked as tests, with no diff", async () => {
    const tests = join(dir, "tests-origin");
    await exec(["init", "-q", "-b", "main", tests]);
    await writeFile(join(tests, "cart.spec.ts"), 'test("cart total", async () => {});\n');
    await exec(["add", "."], { cwd: tests });
    await exec(["-c", "user.name=qa", "-c", "user.email=qa@example.com", "commit", "-qm", "tests"], {
      cwd: tests,
    });
    const testsSha = (await exec(["rev-parse", "HEAD"], { cwd: tests })).stdout.trim();
    const resolved: string[] = [];
    const withTests = parseProjectConfig({
      project: "demo",
      jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
      code_hosts: { local: { type: "github", token: "secret://env/T" } },
      repos: {
        shop: { host: "local", path: "demo-org/demo-shop" },
        e2e: { host: "local", path: "demo-org/shop-tests", role: "tests", default_ref: "main" },
      },
    });
    const { ws, lines, promise } = await run({
      config: withTests,
      codeHosts: {
        local: {
          ...host,
          resolveChange: (locator) => {
            resolved.push(`${locator.repo} ${locator.kind} ${locator.id}`);
            return Promise.resolve({
              host: "local",
              repo: locator.repo,
              kind: "branch" as const,
              id: locator.id,
              headSha: testsSha,
            });
          },
          cloneUrl: (repo) =>
            Promise.resolve(pathToFileURL(repo === "demo-org/shop-tests" ? tests : origin).href),
        },
      },
    });
    const result = await promise;
    expect(resolved).toEqual(["demo-org/shop-tests branch main"]);
    // The analysed change is the app's; the tests repository is context, not part of the change.
    expect(result.shas).toEqual({ shop: sha });
    expect(await readFile(ws.path("repos", "e2e", "cart.spec.ts"), "utf8")).toContain("cart total");
    await expect(readFile(ws.path("repos", "e2e.diff"), "utf8")).rejects.toThrow();
    const record = (await openRunWorkspace(ws.root, key, ws.runId)).record;
    expect(record.repos["e2e"]).toEqual({
      host: "local",
      path: "demo-org/shop-tests",
      sha: testsSha,
      role: "tests",
    });
    expect(record.repos["shop"]?.role).toBeUndefined();
    expect(parseEventLines(lines.join("")).events.map((e) => e.event)).toContain("tests_repo.checked_out");
  });

  it("REQ-CTX-01/AC5: a ticket fetch failure marks the run failed and is rethrown", async () => {
    source = { getTicket: () => Promise.reject(Object.assign(new Error("401"), { code: "JIRA_AUTH" })) };
    const { ws, lines, promise } = await run();
    await expect(promise).rejects.toThrow("401");
    expect((await openRunWorkspace(ws.root, key, ws.runId)).record.status).toBe("failed");
    expect(parseEventLines(lines.join("")).events.at(-1)?.details).toMatchObject({
      status: "error",
      code: "UNEXPECTED",
    });
  });

  it("REQ-CTX-03/AC5: asks interactively when nothing is found and uses the answer", async () => {
    host = {
      ...host,
      findChangesForTicket: () => Promise.resolve([]),
      resolveChange: (l) =>
        Promise.resolve({ host: "local", repo: l.repo, kind: l.kind, id: l.id, headSha: sha }),
    };
    const asked: string[] = [];
    const { promise } = await run({
      askForChange: (message) => {
        asked.push(message);
        return Promise.resolve([`shop=${sha}`]);
      },
    });
    const result = await promise;
    expect(asked[0]).toContain("No PR/MR or branch");
    expect(result.discovery.strategy).toBe("manual");
  });

  it("REQ-CTX-03/AC5: without an answer the original error stops the run", async () => {
    host = { ...host, findChangesForTicket: () => Promise.resolve([]) };
    const { promise } = await run({ askForChange: () => Promise.resolve([]) });
    await expect(promise).rejects.toMatchObject({ code: "CHANGE_NOT_FOUND" });
  });
});
