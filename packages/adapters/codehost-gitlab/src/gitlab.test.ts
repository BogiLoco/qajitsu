import { describe, expect, it } from "vitest";
import { codeHostContract } from "../../../../tests/contract/code-host.contract.js";
import {
  createFakeFetch,
  fixture,
  jsonReply,
  testDeps,
  type Route,
} from "../../../../tests/support/fake-fetch.js";
import { createGitLabCodeHost, toUnifiedDiff } from "./gitlab.js";

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const TOKEN = "gitlab-token-value";
const P = "\\/api\\/v4\\/projects\\/shop%2Fplatform%2Fbackend";
const r = (suffix: string) => new RegExp(`^${P}${suffix}`);

const SHA = "b".repeat(40);
const routes: Route[] = [
  { match: r(`\\/pipelines\\?sha=${SHA}&status=success`), reply: jsonReply([{ id: 31 }, { id: 32 }]) },
  {
    match: r("\\/pipelines\\/31\\/jobs"),
    reply: jsonReply([{ id: 1, name: "android", artifacts_file: null }]),
  },
  {
    match: r("\\/pipelines\\/32\\/jobs"),
    reply: jsonReply([{ id: 2, name: "android", artifacts_file: { filename: "artifacts.zip" } }]),
  },
  { match: r("\\/jobs\\/2\\/artifacts$"), reply: () => new Response(new Uint8Array([80, 75])) },
  { match: r("\\/merge_requests\\?state=all"), reply: jsonReply(fixture("gitlab/merge-requests-list.json")) },
  {
    match: r("\\/merge_requests\\/7\\/diffs"),
    reply: jsonReply(fixture("gitlab/merge-request-7-diffs.json")),
  },
  {
    match: r("\\/merge_requests\\/7\\/notes"),
    reply: jsonReply(fixture("gitlab/merge-request-7-notes.json")),
  },
  { match: r("\\/merge_requests\\/7$"), reply: jsonReply(fixture("gitlab/merge-request-7.json")) },
  {
    match: r("\\/repository\\/branches\\?search=SHOP-482"),
    reply: jsonReply(fixture("gitlab/branches-search.json")),
  },
  { match: r("\\/repository\\/commits\\/"), reply: jsonReply(fixture("gitlab/commit-spike.json")) },
  { match: r("\\/repository\\/compare\\?"), reply: jsonReply(fixture("gitlab/compare.json")) },
  { match: r("$"), reply: jsonReply(fixture("gitlab/project.json")) },
];

const build = (options: { unauthorized?: boolean } = {}) => {
  const fake = createFakeFetch(options.unauthorized ? [{ match: /.*/, reply: jsonReply({}, 401) }] : routes);
  const host = createGitLabCodeHost(
    { alias: "gitlab", baseUrl: "https://gitlab.example.com", token: "secret://env/GITLAB_TOKEN" },
    testDeps(fake.fetch, { "secret://env/GITLAB_TOKEN": TOKEN }),
  );
  return { host, ...fake };
};

codeHostContract("gitlab", (o) => build(o).host, {
  repo: "shop/platform/backend",
  changeUrl: "https://gitlab.example.com/shop/platform/backend/-/merge_requests/7/diffs",
  change: { kind: "mr", id: "7", headSha: H1 },
  branchOnly: { id: "spike/SHOP-482-ui", headSha: H2 },
  token: TOKEN,
  cloneUrl: "https://gitlab.example.com/shop/platform/backend.git",
});

describe("GitLab code host (REQ-CTX-02)", () => {
  it("REQ-CTX-02/AC1: self-managed uses <base_url>/api/v4 with PRIVATE-TOKEN", async () => {
    const { host, requests } = build();
    await host.resolveChange({ repo: "shop/platform/backend", kind: "mr", id: "7" });
    expect(requests[0]?.url.href).toBe(
      "https://gitlab.example.com/api/v4/projects/shop%2Fplatform%2Fbackend/merge_requests/7",
    );
    expect(requests[0]?.headers["private-token"]).toBe(TOKEN);
  });

  it("REQ-CTX-05: builds a unified diff with renames, new and deleted files", async () => {
    const { host } = build();
    const change = await host.resolveChange({ repo: "shop/platform/backend", kind: "mr", id: "7" });
    const diff = await host.getDiff(change);
    expect(diff).toContain(
      "diff --git a/src/discount.ts b/src/discount.ts\n--- a/src/discount.ts\n+++ b/src/discount.ts\n@@",
    );
    expect(diff).toContain("rename from src/old-name.ts\nrename to src/new-name.ts");
    expect(diff).toContain("new file mode 100644\n--- /dev/null\n+++ b/src/added.ts");
    expect(diff).toContain("deleted file mode 100644\n--- a/src/removed.ts\n+++ /dev/null");
    expect(toUnifiedDiff([])).toBe("");
  });

  it("REQ-CTX-05: skips system notes and keeps file positions", async () => {
    const { host } = build();
    const change = await host.resolveChange({ repo: "shop/platform/backend", kind: "mr", id: "7" });
    expect(await host.getReviewComments(change)).toEqual([
      { author: "reviewer-1", body: "Codes must not stack.", path: "src/discount.ts", line: 1 },
      { author: "author-1", body: "Ready for QA." },
    ]);
  });

  it("diffs a SHA against the default branch via compare", async () => {
    const { host, requests } = build();
    const change = await host.resolveChange({ repo: "shop/platform/backend", kind: "sha", id: H2 });
    expect(change.url).toBe(`https://gitlab.example.com/shop/platform/backend/-/commit/${H2}`);
    expect(await host.getDiff(change)).toContain("diff --git a/a.ts b/a.ts");
    expect(requests.at(-1)?.url.searchParams.get("from")).toBe("main");
    expect(await host.getReviewComments(change)).toEqual([]);
  });

  it("parses tree and commit URLs and rejects malformed MR ids", async () => {
    const { host } = build();
    expect(
      host.parseChangeUrl("https://gitlab.example.com/shop/platform/backend/-/tree/SHOP-482-discounts"),
    ).toEqual({
      repo: "shop/platform/backend",
      kind: "branch",
      id: "SHOP-482-discounts",
    });
    expect(
      host.parseChangeUrl("https://gitlab.example.com/shop/platform/backend/-/issues/1"),
    ).toBeUndefined();
    await expect(
      host.resolveChange({ repo: "shop/platform/backend", kind: "mr", id: "x" }),
    ).rejects.toMatchObject({
      code: "GITLAB_MR_INVALID",
    });
  });

  it("defaults to gitlab.com", async () => {
    const fake = createFakeFetch([{ match: /.*/, reply: jsonReply(fixture("gitlab/merge-request-7.json")) }]);
    const host = createGitLabCodeHost(
      { alias: "gl", token: "secret://env/T" },
      testDeps(fake.fetch, { "secret://env/T": "t-123456" }),
    );
    await host.resolveChange({ repo: "a/b", kind: "mr", id: "7" });
    expect(fake.requests[0]?.url.origin).toBe("https://gitlab.com");
  });
});

describe("GitLab CI artifacts (REQ-ENV-06/AC1)", () => {
  it("REQ-ENV-06/AC1: downloads the artifacts of the named successful job for exactly this SHA", async () => {
    const { host, requests } = build();
    expect([...((await host.downloadArtifact?.("shop/platform/backend", SHA, "android")) ?? [])]).toEqual([
      80, 75,
    ]);
    expect(requests.at(-1)?.url.pathname).toBe("/api/v4/projects/shop%2Fplatform%2Fbackend/jobs/2/artifacts");
    expect(requests.at(-1)?.headers["private-token"]).toBe(TOKEN);
    await expect(host.downloadArtifact?.("shop/platform/backend", SHA, "ios")).rejects.toMatchObject({
      code: "GITLAB_ARTIFACT_NOT_FOUND",
    });
    await expect(host.downloadArtifact?.("shop/platform/backend", "main", "x")).rejects.toMatchObject({
      code: "GITLAB_SHA_INVALID",
    });
  });
});

describe("doctor access check (REQ-GEN-03/AC2)", () => {
  it("REQ-GEN-03/AC2: /user answers for a valid token", async () => {
    const fake = createFakeFetch([{ match: /^\/api\/v4\/user$/, reply: jsonReply({ id: 1 }) }]);
    const host = createGitLabCodeHost(
      { alias: "gitlab", baseUrl: "https://gitlab.example.com", token: "secret://env/GITLAB_TOKEN" },
      testDeps(fake.fetch, { "secret://env/GITLAB_TOKEN": TOKEN }),
    );
    expect(await host.check?.()).toEqual({ ok: true, detail: "GitLab reachable, token accepted" });
    expect((await build({ unauthorized: true }).host.check?.())?.ok).toBe(false);
  });
});

describe("MR note and commit status (REQ-CI-04/AC4)", () => {
  it("REQ-CI-04/AC4: posts or updates the QAJitsu note and maps failure to failed", async () => {
    const sha = "d".repeat(40);
    let notes: { id: number; body: string; author: { id: number } }[] = [
      { id: 4, body: "<!-- qj --> spoof", author: { id: 99 } },
    ];
    const fake = createFakeFetch([
      { match: r("\\/merge_requests\\/7\\/notes\\?"), reply: () => new Response(JSON.stringify(notes)) },
      { method: "POST", match: r("\\/merge_requests\\/7\\/notes$"), reply: jsonReply({ id: 5 }) },
      { match: /^\/api\/v4\/user$/, reply: jsonReply({ id: 7 }) },
      { method: "PUT", match: r("\\/merge_requests\\/7\\/notes\\/5$"), reply: jsonReply({ id: 5 }) },
      { method: "POST", match: r(`\\/statuses\\/${sha}$`), reply: jsonReply({ id: 1 }) },
    ]);
    const host = createGitLabCodeHost(
      { alias: "gitlab", baseUrl: "https://gitlab.example.com", token: "secret://env/GITLAB_TOKEN" },
      testDeps(fake.fetch, { "secret://env/GITLAB_TOKEN": TOKEN }),
    );
    const target = { repo: "shop/platform/backend", kind: "mr" as const, id: "7" };
    await host.upsertComment?.(target, "<!-- qj --> a", "<!-- qj -->");
    notes = [...notes, { id: 5, body: "<!-- qj --> a", author: { id: 7 } }];
    await host.upsertComment?.(target, "<!-- qj --> b", "<!-- qj -->");
    expect(fake.requests.filter((q) => q.method !== "GET").map((q) => q.method)).toEqual(["POST", "PUT"]);
    await host.setCommitStatus?.("shop/platform/backend", sha, {
      state: "failure",
      context: "qajitsu/DEMO-1",
      description: "1 FAILED",
    });
    expect(JSON.parse(fake.requests.at(-1)?.body ?? "{}")).toEqual({
      state: "failed",
      name: "qajitsu/DEMO-1",
      description: "1 FAILED",
    });
    await expect(
      host.setCommitStatus?.("shop/platform/backend", "x", {
        state: "success",
        context: "c",
        description: "d",
      }),
    ).rejects.toMatchObject({ code: "GITLAB_SHA_INVALID" });
    await expect(host.upsertComment?.({ ...target, id: "y" }, "b", "m")).rejects.toMatchObject({
      code: "GITLAB_MR_INVALID",
    });
  });
});
