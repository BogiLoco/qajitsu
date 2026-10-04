import { fileURLToPath } from "node:url";
import { TicketKeySchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { ticketSourceContract } from "../../../../tests/contract/ticket-source.contract.js";
import {
  createFakeFetch,
  fixture,
  jsonReply,
  testDeps,
  type Route,
} from "../../../../tests/support/fake-fetch.js";
import { createFileTicketSource } from "./file-source.js";
import { createJiraCloudTicketSource } from "./jira-cloud.js";

const BASE = "https://jira.example.com";
const secrets = {
  "secret://env/JIRA_EMAIL": "qa@example.com",
  "secret://env/JIRA_TOKEN": "jira-api-token-123",
};
const config = { baseUrl: BASE, email: "secret://env/JIRA_EMAIL", token: "secret://env/JIRA_TOKEN" };

const routes = (overrides: Route[] = []): Route[] => [
  ...overrides,
  {
    match: /^\/rest\/api\/3\/issue\/SHOP-482\?/,
    reply: jsonReply(fixture("jira/cloud/issue-SHOP-482.json")),
  },
  {
    match: /^\/rest\/api\/3\/issue\/SHOP-483\?/,
    reply: jsonReply(fixture("jira/cloud/issue-SHOP-483-custom-ac.json")),
  },
  {
    match: /dev-status.*applicationType=GitHub&dataType=pullrequest/,
    reply: jsonReply(fixture("jira/cloud/dev-status-github-pullrequest.json")),
  },
  {
    match: /dev-status.*applicationType=GitLab&dataType=pullrequest/,
    reply: jsonReply(fixture("jira/cloud/dev-status-gitlab-pullrequest.json")),
  },
  {
    match: /dev-status.*dataType=branch/,
    reply: jsonReply(fixture("jira/cloud/dev-status-github-pullrequest.json")),
  },
];

const cloud = (extra: Route[] = []) => {
  const fake = createFakeFetch(routes(extra));
  const deps = testDeps(fake.fetch, secrets);
  return { source: createJiraCloudTicketSource(config, deps), ...fake, deps };
};

ticketSourceContract("jira cloud", () => cloud().source, { known: "SHOP-482", missing: "SHOP-999" });
ticketSourceContract(
  "file",
  () =>
    createFileTicketSource(fileURLToPath(new URL("../../../../examples/demo-shop/tickets", import.meta.url))),
  { known: "DEMO-1", missing: "DEMO-999" },
);

describe("Jira Cloud ticket source (REQ-CTX-01)", () => {
  const key = TicketKeySchema.parse("SHOP-482");

  it("REQ-CTX-01/AC1+AC4: maps Jira Cloud ticket fields, comments, links and attachments", async () => {
    const ticket = await cloud().source.getTicket(key);
    expect(ticket).toMatchObject({
      summary: "Cart total with discount codes",
      issueType: "Story",
      status: "Ready for QA",
      labels: ["cart", "api"],
      components: ["shop-api"],
      acceptanceCriteria: ["GET `/cart` returns the total rounded once to 2 decimals.", "Codes never stack."],
      comments: [
        {
          author: "Product Owner",
          body: "Codes are percentage only for now.",
          created: "2026-09-30T10:12:00.000+0000",
        },
      ],
      linkedKeys: ["SHOP-400", "SHOP-311"],
      attachments: [{ name: "mockup.png", mimeType: "image/png" }],
    });
  });

  it("REQ-CTX-03/AC1: reads PRs, MRs and branches from the development panel, deduplicated", async () => {
    const ticket = await cloud().source.getTicket(key);
    expect(ticket.developmentLinks).toEqual([
      {
        url: "https://github.com/example-org/shop-web/pull/12",
        kind: "pr",
        title: "SHOP-482 discount codes in cart",
        sourceBranch: "feature/SHOP-482-cart-discounts",
        targetBranch: "main",
      },
      {
        url: "https://github.com/example-org/shop-web/tree/feature/SHOP-482-cart-discounts",
        kind: "branch",
        sourceBranch: "feature/SHOP-482-cart-discounts",
      },
      {
        url: "https://gitlab.example.com/shop/platform/backend/-/merge_requests/7",
        kind: "mr",
        title: "SHOP-482 cart discount API",
        sourceBranch: "SHOP-482-discounts",
        targetBranch: "main",
      },
    ]);
  });

  it("REQ-CTX-01/AC1: reads acceptance criteria from a configured custom field", async () => {
    const fake = createFakeFetch(routes());
    const source = createJiraCloudTicketSource(
      { ...config, acceptanceCriteriaField: "customfield_10042" },
      testDeps(fake.fetch, secrets),
    );
    const ticket = await source.getTicket(TicketKeySchema.parse("SHOP-483"));
    expect(ticket.acceptanceCriteria).toEqual([
      "Negative quantity returns 422.",
      "Zero quantity returns 422.",
    ]);
    expect(ticket.description).toBe("");
    expect(fake.requests[0]?.url.search).toContain("customfield_10042");
  });

  it("authenticates with basic auth built from secret references", async () => {
    const { source, requests } = cloud();
    await source.getTicket(key);
    const expected = `Basic ${Buffer.from("qa@example.com:jira-api-token-123").toString("base64")}`;
    expect(requests.every((r) => r.headers["authorization"] === expected)).toBe(true);
  });

  it("REQ-CTX-03: an unavailable development panel is logged and yields no links", async () => {
    const { source, deps } = cloud([{ match: /dev-status/, reply: jsonReply({}, 403) }]);
    const ticket = await source.getTicket(key);
    expect(ticket.developmentLinks).toEqual([]);
    expect(deps.logger.entries.some((e) => e.level === "warn")).toBe(true);
  });

  it("REQ-CTX-01/AC5: auth failures and malformed responses are adapter errors", async () => {
    await expect(
      cloud([{ match: /issue\/SHOP-482/, reply: jsonReply({}, 401) }]).source.getTicket(key),
    ).rejects.toMatchObject({ code: "JIRA_AUTH" });
    await expect(
      cloud([{ match: /issue\/SHOP-482/, reply: jsonReply({ id: 1 }) }]).source.getTicket(key),
    ).rejects.toMatchObject({ code: "JIRA_MALFORMED" });
  });

  it("REQ-CTX-01/AC3: makes no network call for a malformed key", async () => {
    const { source, requests } = cloud();
    await expect(source.getTicket("shop-1; rm -rf" as never)).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("stops on an aborted signal", async () => {
    await expect(cloud().source.getTicket(key, AbortSignal.abort())).rejects.toThrow();
  });
});

describe("file ticket source", () => {
  it("rejects a file whose key does not match", async () => {
    const dir = fileURLToPath(new URL("../../../../fixtures/jira/file-mismatch", import.meta.url));
    const source = createFileTicketSource(dir);
    await expect(source.getTicket(TicketKeySchema.parse("DEMO-7"))).rejects.toMatchObject({
      code: "JIRA_MALFORMED",
    });
    await expect(source.getTicket(TicketKeySchema.parse("DEMO-9"))).rejects.toMatchObject({
      code: "JIRA_MALFORMED",
    });
  });
});

describe("Jira Data Center ticket source (REQ-PUB-03, REQ-CTX-01)", () => {
  it("reads REST v2 with a personal access token and converts wiki markup", async () => {
    const fake = createFakeFetch([
      {
        match: /^\/rest\/api\/2\/issue\/SHOP-482\?/,
        reply: jsonReply(fixture("jira/datacenter/issue-SHOP-482.json")),
      },
      { match: /dev-status/, reply: jsonReply({ detail: [] }) },
    ]);
    const source = createJiraCloudTicketSource(
      { baseUrl: BASE, flavor: "datacenter", token: "secret://env/JIRA_TOKEN" },
      testDeps(fake.fetch, secrets),
    );
    const ticket = await source.getTicket(TicketKeySchema.parse("SHOP-482"));
    expect(ticket.acceptanceCriteria).toEqual([
      "GET `/cart` returns the total rounded once.",
      "Codes never stack.",
    ]);
    expect(ticket.description).toContain("my **discount code** applied");
    expect(ticket.description).toContain('```\n{"code":"SAVE10"}\n```');
    expect(ticket.description).toContain("1. first");
    expect(ticket.comments[0]?.body).toBe("Percentage codes only.");
    expect(fake.requests[0]?.headers["authorization"]).toBe("Bearer jira-api-token-123");
  });

  it("Cloud without an e-mail is refused", async () => {
    const source = createJiraCloudTicketSource(
      { baseUrl: BASE, token: "secret://env/JIRA_TOKEN" },
      testDeps(createFakeFetch(routes()).fetch, secrets),
    );
    await expect(source.getTicket(TicketKeySchema.parse("SHOP-482"))).rejects.toMatchObject({
      code: "JIRA_AUTH_MISSING",
    });
  });
});

describe("doctor access check (REQ-GEN-03/AC2)", () => {
  it("REQ-GEN-03/AC2: Jira /myself accepts the token; file sources check their folder", async () => {
    const { source } = cloud([{ match: /^\/rest\/api\/3\/myself$/, reply: jsonReply({ accountId: "x" }) }]);
    expect(await source.check?.()).toEqual({ ok: true, detail: "Jira Cloud reachable, token accepted" });
    const failing = cloud([{ match: /^\/rest\/api\/3\/myself$/, reply: jsonReply({}, 401) }]);
    expect((await failing.source.check?.())?.ok).toBe(false);
    const { createFileTicketSource } = await import("./file-source.js");
    expect((await createFileTicketSource("/definitely/missing").check?.())?.ok).toBe(false);
  });
});
