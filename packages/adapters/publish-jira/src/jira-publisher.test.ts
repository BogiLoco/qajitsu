import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunIdSchema, TicketKeySchema, type PublishInput } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeFetch, jsonReply, testDeps, type Route } from "../../../../tests/support/fake-fetch.js";
import { createJiraPublisher } from "./jira-publisher.js";

const BASE = "https://jira.example.com";
const secrets = {
  "secret://env/JIRA_EMAIL": "qa@example.com",
  "secret://env/JIRA_TOKEN": "jira-token-123456",
};
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const files = async () => {
  const dir = await mkdtemp(join(tmpdir(), "qj-pub-"));
  dirs.push(dir);
  await writeFile(join(dir, "evidence.zip"), "zip-bytes");
  await writeFile(join(dir, "big.webm"), "x");
  return dir;
};

const input = (dir: string, previous?: PublishInput["previous"]): PublishInput => ({
  ticket: TicketKeySchema.parse("SHOP-482"),
  runId: RunIdSchema.parse("20261003-1046-aaaa"),
  comment: { adf: { version: 1, type: "doc", content: [] }, wiki: "h3. results" },
  attachments: [
    {
      path: join(dir, "evidence.zip"),
      name: "SHOP-482_20261003-1046-aaaa_evidence.zip",
      mimeType: "application/zip",
      bytes: 9,
    },
    { path: join(dir, "big.webm"), name: "TC-01_video.webm", mimeType: "video/webm", bytes: 50_000_000 },
  ],
  ...(previous ? { previous } : {}),
});

const routes = (extra: Route[] = []): Route[] => [
  ...extra,
  {
    method: "POST",
    match: /^\/rest\/api\/[23]\/issue\/SHOP-482\/comment$/,
    reply: jsonReply({ id: "10001" }, 201),
  },
  {
    method: "PUT",
    match: /^\/rest\/api\/[23]\/issue\/SHOP-482\/comment\/10001$/,
    reply: jsonReply({ id: "10001" }),
  },
  {
    method: "POST",
    match: /^\/rest\/api\/[23]\/issue\/SHOP-482\/attachments$/,
    reply: (r) => jsonReply((r.files ?? []).map((f, i) => ({ id: 500 + i, filename: f })))(r),
  },
];

describe("Jira publisher (REQ-PUB-01..04)", () => {
  it("REQ-PUB-03/AC1 + REQ-PUB-02/AC1+AC3: Cloud posts an ADF comment and attachments, skipping oversized files", async () => {
    const dir = await files();
    const fake = createFakeFetch(routes());
    const publisher = createJiraPublisher(
      {
        flavor: "cloud",
        baseUrl: BASE,
        email: "secret://env/JIRA_EMAIL",
        token: "secret://env/JIRA_TOKEN",
        maxAttachmentBytes: 10_000_000,
      },
      testDeps(fake.fetch, secrets),
    );
    const result = await publisher.publish(input(dir));
    expect(result).toEqual({
      commentId: "10001",
      url: "https://jira.example.com/browse/SHOP-482?focusedCommentId=10001",
      updated: false,
      attachments: [{ name: "SHOP-482_20261003-1046-aaaa_evidence.zip", id: "500" }],
      skipped: [{ name: "TC-01_video.webm", reason: "50 MB is over the 10 MB limit" }],
    });
    const [comment, upload] = fake.requests;
    expect(comment?.url.pathname).toBe("/rest/api/3/issue/SHOP-482/comment");
    expect(JSON.parse(comment?.body ?? "{}")).toEqual({ body: { version: 1, type: "doc", content: [] } });
    expect(comment?.headers["authorization"]).toBe(
      `Basic ${Buffer.from("qa@example.com:jira-token-123456").toString("base64")}`,
    );
    expect(upload?.headers["x-atlassian-token"]).toBe("no-check");
    expect(upload?.files).toEqual(["SHOP-482_20261003-1046-aaaa_evidence.zip"]);
  });

  it("REQ-PUB-04/AC1: publishing the same run again updates the comment and does not re-upload", async () => {
    const dir = await files();
    const fake = createFakeFetch(routes());
    const publisher = createJiraPublisher(
      {
        flavor: "cloud",
        baseUrl: BASE,
        email: "secret://env/JIRA_EMAIL",
        token: "secret://env/JIRA_TOKEN",
        maxAttachmentBytes: 1e9,
      },
      testDeps(fake.fetch, secrets),
    );
    const result = await publisher.publish(
      input(dir, { commentId: "10001", attachmentNames: ["SHOP-482_20261003-1046-aaaa_evidence.zip"] }),
    );
    expect(result.updated).toBe(true);
    expect(fake.requests.map((r) => r.method)).toEqual(["PUT", "POST"]);
    expect(fake.requests[1]?.files).toEqual(["TC-01_video.webm"]);
  });

  it("REQ-PUB-04: a comment deleted in Jira is recreated", async () => {
    const dir = await files();
    const fake = createFakeFetch(
      routes([{ method: "PUT", match: /comment\/10001$/, reply: jsonReply({}, 404) }]),
    );
    const publisher = createJiraPublisher(
      {
        flavor: "cloud",
        baseUrl: BASE,
        email: "secret://env/JIRA_EMAIL",
        token: "secret://env/JIRA_TOKEN",
        maxAttachmentBytes: 1,
      },
      testDeps(fake.fetch, secrets),
    );
    const result = await publisher.publish(input(dir, { commentId: "10001", attachmentNames: [] }));
    expect(result).toMatchObject({ updated: false, commentId: "10001" });
  });

  it("REQ-PUB-03/AC2: Data Center uses REST v2, wiki markup and a personal access token", async () => {
    const dir = await files();
    const fake = createFakeFetch(routes());
    const publisher = createJiraPublisher(
      { flavor: "datacenter", baseUrl: BASE, token: "secret://env/JIRA_TOKEN", maxAttachmentBytes: 1 },
      testDeps(fake.fetch, secrets),
    );
    await publisher.publish(input(dir));
    expect(fake.requests[0]?.url.pathname).toBe("/rest/api/2/issue/SHOP-482/comment");
    expect(JSON.parse(fake.requests[0]?.body ?? "{}")).toEqual({ body: "h3. results" });
    expect(fake.requests[0]?.headers["authorization"]).toBe("Bearer jira-token-123456");
  });

  it("errors are adapter errors; Cloud without an e-mail is refused", async () => {
    const dir = await files();
    const denied = createJiraPublisher(
      {
        flavor: "cloud",
        baseUrl: BASE,
        email: "secret://env/JIRA_EMAIL",
        token: "secret://env/JIRA_TOKEN",
        maxAttachmentBytes: 1,
      },
      testDeps(createFakeFetch([{ method: "POST", match: /.*/, reply: jsonReply({}, 403) }]).fetch, secrets),
    );
    await expect(denied.publish(input(dir))).rejects.toMatchObject({ code: "JIRA_AUTH" });
    const noEmail = createJiraPublisher(
      { flavor: "cloud", baseUrl: BASE, token: "secret://env/JIRA_TOKEN", maxAttachmentBytes: 1 },
      testDeps(createFakeFetch(routes()).fetch, secrets),
    );
    await expect(noEmail.publish(input(dir))).rejects.toMatchObject({ code: "JIRA_AUTH_MISSING" });
  });
});
