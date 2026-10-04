import { generateKeyPairSync } from "node:crypto";
import { TicketKeySchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { codeHostContract } from "../../../../tests/contract/code-host.contract.js";
import {
  createFakeFetch,
  fixture,
  jsonReply,
  testDeps,
  textReply,
  type Route,
} from "../../../../tests/support/fake-fetch.js";
import { createAppJwt } from "./github-app.js";
import { createGitHubCodeHost } from "./github.js";

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const TOKEN = "github-token-value";

const routes: Route[] = [
  {
    match: /^\/repos\/example-org\/shop-web\/pulls\?state=all/,
    reply: jsonReply(fixture("github/pulls-list.json")),
  },
  { match: /^\/repos\/example-org\/shop-web\/branches\?/, reply: jsonReply(fixture("github/branches.json")) },
  {
    match: /^\/repos\/example-org\/shop-web\/pulls\/12\/comments/,
    reply: jsonReply(fixture("github/pull-12-review-comments.json")),
  },
  {
    match: /^\/repos\/example-org\/shop-web\/issues\/12\/comments/,
    reply: jsonReply(fixture("github/issue-12-comments.json")),
  },
  {
    match: /^\/repos\/example-org\/shop-web\/pulls\/12$/,
    reply: (req) =>
      req.headers["accept"] === "application/vnd.github.diff"
        ? new Response(fixture("github/pull-12.diff"))
        : new Response(fixture("github/pull-12.json")),
  },
  {
    match: /^\/repos\/example-org\/shop-web\/commits\//,
    reply: jsonReply(fixture("github/commit-spike.json")),
  },
  { match: /^\/repos\/example-org\/shop-web$/, reply: jsonReply({ default_branch: "main" }) },
  {
    match: /^\/repos\/example-org\/shop-web\/compare\/main\.\.\.2{40}$/,
    reply: textReply(fixture("github/pull-12.diff")),
  },
];

const build = (options: { unauthorized?: boolean; baseUrl?: string; extra?: Route[] } = {}) => {
  const fake = createFakeFetch(
    options.unauthorized
      ? [{ match: /.*/, reply: jsonReply({}, 401) }]
      : [...(options.extra ?? []), ...routes],
  );
  const deps = testDeps(fake.fetch, { "secret://env/GITHUB_TOKEN": TOKEN });
  const host = createGitHubCodeHost(
    {
      alias: "github",
      token: "secret://env/GITHUB_TOKEN",
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    },
    deps,
  );
  return { host, ...fake };
};

codeHostContract("github", (o) => build(o).host, {
  repo: "example-org/shop-web",
  changeUrl: "https://github.com/example-org/shop-web/pull/12",
  change: { kind: "pr", id: "12", headSha: H1 },
  branchOnly: { id: "spike/SHOP-482-ui", headSha: H2 },
  token: TOKEN,
  cloneUrl: "https://github.com/example-org/shop-web.git",
});

describe("GitHub code host (REQ-CTX-02)", () => {
  const key = TicketKeySchema.parse("SHOP-482");

  it("REQ-CTX-03/AC2: records a branch match when only the PR branch mentions the key", async () => {
    const changes = await build().host.findChangesForTicket(key, ["example-org/shop-web"]);
    expect(changes.find((c) => c.id === "13")).toMatchObject({
      matchedBy: "branch",
      sourceBranch: "shop-482-followup",
    });
    expect(changes.filter((c) => c.sourceBranch === "feature/SHOP-482-cart-discounts")).toHaveLength(1);
  });

  it("REQ-CTX-02/AC1: GitHub Enterprise Server uses <base_url>/api/v3", async () => {
    const { host, requests } = build({
      baseUrl: "https://ghe.example.com",
      extra: [
        {
          match: /^\/api\/v3\/repos\/example-org\/shop-web\/pulls\/12$/,
          reply: jsonReply(fixture("github/pull-12.json")),
        },
      ],
    });
    await host.resolveChange({ repo: "example-org/shop-web", kind: "pr", id: "12" });
    expect(requests[0]?.url.origin).toBe("https://ghe.example.com");
    expect(host.parseChangeUrl("https://ghe.example.com/example-org/shop-web/pull/12/files")).toEqual({
      repo: "example-org/shop-web",
      kind: "pr",
      id: "12",
    });
    expect(await host.cloneUrl("example-org/shop-web")).toContain(
      "@ghe.example.com/example-org/shop-web.git",
    );
  });

  it("sends the token as a bearer header and the API version", async () => {
    const { host, requests } = build();
    await host.resolveChange({ repo: "example-org/shop-web", kind: "pr", id: "12" });
    expect(requests[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-github-api-version": "2022-11-28",
    });
  });

  it("diffs a branch against the default branch and has no review comments for it", async () => {
    const { host } = build();
    const change = await host.resolveChange({ repo: "example-org/shop-web", kind: "sha", id: H2 });
    expect(change).toMatchObject({
      kind: "sha",
      targetBranch: "main",
      url: `https://github.com/example-org/shop-web/commit/${H2}`,
    });
    expect(await host.getDiff(change)).toContain("diff --git");
    expect(await host.getReviewComments(change)).toEqual([]);
    expect(host.parseChangeUrl(`https://github.com/example-org/shop-web/commit/${H2}`)).toMatchObject({
      kind: "sha",
    });
    expect(host.parseChangeUrl("https://github.com/example-org/shop-web/issues/3")).toBeUndefined();
  });

  it("rejects . and .. path segments so GHES paths cannot escape /api/v3", async () => {
    for (const repo of ["../..", "./x", "a/..", "a/."]) {
      await expect(build().host.resolveChange({ repo, kind: "pr", id: "1" })).rejects.toMatchObject({
        code: "GITHUB_REPO_INVALID",
      });
    }
    expect(build().host.parseChangeUrl("https://github.com/%2e%2e/%2e%2e/pull/1")).toBeUndefined();
  });

  it("rejects a non-numeric PR id", async () => {
    await expect(
      build().host.resolveChange({ repo: "example-org/shop-web", kind: "pr", id: "x" }),
    ).rejects.toMatchObject({
      code: "GITHUB_PR_INVALID",
    });
  });

  it("paginates until a short page", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ name: `b${String(i)}`, commit: { sha: H2 } }));
    const { host, requests } = build({
      extra: [
        { match: /^\/repos\/example-org\/shop-web\/branches\?per_page=100&page=1$/, reply: jsonReply(full) },
        {
          match: /^\/repos\/example-org\/shop-web\/branches\?per_page=100&page=2$/,
          reply: jsonReply([{ name: "SHOP-482", commit: { sha: H2 } }]),
        },
      ],
    });
    const changes = await host.findChangesForTicket(key, ["example-org/shop-web"]);
    expect(changes.some((c) => c.id === "SHOP-482")).toBe(true);
    expect(requests.filter((r) => r.url.pathname.endsWith("/branches"))).toHaveLength(2);
  });

  it("REQ-CTX-02/AC3: authenticates as a GitHub App installation and caches the token", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const fake = createFakeFetch([
      {
        method: "POST",
        match: /^\/app\/installations\/456\/access_tokens$/,
        reply: jsonReply({ token: "inst-token-1", expires_at: "2026-10-03T11:46:00Z" }, 201),
      },
      ...routes,
    ]);
    const deps = testDeps(fake.fetch, { "secret://env/GH_APP_KEY": pem });
    const host = createGitHubCodeHost(
      {
        alias: "github",
        app: { appId: "123", installationId: "456", privateKey: "secret://env/GH_APP_KEY" },
      },
      deps,
    );
    await host.resolveChange({ repo: "example-org/shop-web", kind: "pr", id: "12" });
    await host.resolveChange({ repo: "example-org/shop-web", kind: "pr", id: "12" });
    const tokenCalls = fake.requests.filter((r) => r.method === "POST");
    expect(tokenCalls).toHaveLength(1);
    const jwt = tokenCalls[0]?.headers["authorization"]?.replace("Bearer ", "") ?? "";
    const [header, payload, signature] = jwt.split(".");
    const { createVerify } = await import("node:crypto");
    const verify = createVerify("RSA-SHA256");
    verify.update(`${header ?? ""}.${payload ?? ""}`);
    expect(verify.verify(publicKey, Buffer.from(signature ?? "", "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString())).toMatchObject({ iss: "123" });
    expect(fake.requests.at(-1)?.headers["authorization"]).toBe("Bearer inst-token-1");
    expect(deps.registered).toContain("inst-token-1");
    expect(deps.registered).toContain(jwt);
    expect(await host.cloneUrl("example-org/shop-web")).toContain("x-access-token:inst-token-1@");
  });

  it("fails clearly on an invalid App key or missing credentials", () => {
    expect(() => createAppJwt("1", "not a key", new Date())).toThrow(/private key/);
    expect(() => createGitHubCodeHost({ alias: "gh" }, testDeps(createFakeFetch([]).fetch))).toThrow(
      /token or a GitHub App/,
    );
  });
});

describe("GitHub listing limits", () => {
  it("warns when a listing is truncated at the page limit", async () => {
    const full = (n: number) =>
      Array.from({ length: 100 }, (_, i) => ({
        name: `b${String(n)}-${String(i)}`,
        commit: { sha: "2".repeat(40) },
      }));
    const fake = createFakeFetch([
      { match: /\/pulls\?state=all/, reply: jsonReply([]) },
      {
        match: /\/branches\?per_page=100&page=(\d)/,
        reply: (req) => new Response(JSON.stringify(full(Number(req.url.searchParams.get("page"))))),
      },
    ]);
    const deps = testDeps(fake.fetch, { "secret://env/GITHUB_TOKEN": "t-123456" });
    const host = createGitHubCodeHost({ alias: "github", token: "secret://env/GITHUB_TOKEN" }, deps);
    await host.findChangesForTicket(TicketKeySchema.parse("SHOP-482"), ["example-org/shop-web"]);
    expect(deps.logger.entries.some((e) => e.level === "warn" && e.message.includes("truncated"))).toBe(true);
  });
});

describe("GitHub Actions artifacts (REQ-ENV-06/AC1)", () => {
  const sha = "a".repeat(40);
  it("REQ-ENV-06/AC1: downloads the named artifact of a successful run for exactly this SHA; storage gets no token", async () => {
    const { host, requests } = build({
      extra: [
        {
          match: new RegExp(`^/repos/example-org/shop-web/actions/runs\\?head_sha=${sha}&status=success`),
          reply: jsonReply({ workflow_runs: [{ id: 11 }, { id: 12 }] }),
        },
        {
          match: /^\/repos\/example-org\/shop-web\/actions\/runs\/11\/artifacts/,
          reply: jsonReply({ artifacts: [{ id: 5, name: "app-debug", expired: true }] }),
        },
        {
          match: /^\/repos\/example-org\/shop-web\/actions\/runs\/12\/artifacts/,
          reply: jsonReply({
            artifacts: [
              { id: 7, name: "app-debug", expired: false },
              { id: 8, name: "other", expired: false },
            ],
          }),
        },
        {
          match: /^\/repos\/example-org\/shop-web\/actions\/artifacts\/7\/zip$/,
          reply: () => new Response(new Uint8Array([80, 75, 3, 4])),
        },
      ],
    });
    const bytes = await host.downloadArtifact?.("example-org/shop-web", sha, "app-debug");
    expect([...(bytes ?? [])]).toEqual([80, 75, 3, 4]);
    expect(requests.at(-1)?.url.pathname).toBe("/repos/example-org/shop-web/actions/artifacts/7/zip");
    await expect(host.downloadArtifact?.("example-org/shop-web", sha, "missing")).rejects.toMatchObject({
      code: "GITHUB_ARTIFACT_NOT_FOUND",
    });
    await expect(host.downloadArtifact?.("example-org/shop-web", "HEAD", "x")).rejects.toMatchObject({
      code: "GITHUB_SHA_INVALID",
    });
  });
});

describe("doctor access check (REQ-GEN-03/AC2)", () => {
  it("REQ-GEN-03/AC2: reports accepted credentials or the error code, never the token", async () => {
    const ok = build({ extra: [{ match: /^\/rate_limit$/, reply: jsonReply({ resources: {} }) }] });
    expect(await ok.host.check?.()).toEqual({ ok: true, detail: "GitHub reachable, credentials accepted" });
    const denied = build({ unauthorized: true });
    const r = await denied.host.check?.();
    expect(r?.ok).toBe(false);
    expect(r?.detail).toMatch(/^GITHUB_/);
    expect(r?.detail).not.toContain(TOKEN);
  });
});
