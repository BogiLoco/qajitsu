import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeFetch, jsonReply, testDeps } from "../../../../tests/support/fake-fetch.js";
import { componentTag, createFileBugSource, createJiraBugSource } from "./jira-bugs.js";

const SECRETS = {
  "secret://env/JIRA_EMAIL": "qa@example.com",
  "secret://env/JIRA_TOKEN": "jira-token-value",
};
const listed = (n: number, updated = "2026-09-0" + String((n % 9) + 1) + "T10:00:00.000+0000") => ({
  key: `SHOP-${String(n)}`,
  fields: { summary: `Bug ${String(n)}`, updated, components: [{ name: "Payments API" }] },
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("resolved Jira bugs as a knowledge source (REQ-KNOW-12/AC2)", () => {
  it("REQ-KNOW-12/AC2: Cloud lists resolved bugs of a component page by page with update times; JQL values are quoted", async () => {
    const fake = createFakeFetch([
      {
        match: /^\/rest\/api\/3\/search\/jql\?(?!.*nextPageToken)/,
        reply: jsonReply({ issues: [listed(1), listed(2)], nextPageToken: "p2" }),
      },
      {
        match: /^\/rest\/api\/3\/search\/jql\?.*nextPageToken=p2/,
        reply: jsonReply({ issues: [listed(3)] }),
      },
    ]);
    const source = createJiraBugSource(
      {
        baseUrl: "https://shop.atlassian.net",
        email: "secret://env/JIRA_EMAIL",
        token: "secret://env/JIRA_TOKEN",
        projectKey: "SHOP",
        component: 'Pay"ments',
      },
      testDeps(fake.fetch, SECRETS),
    );
    const docs = await source.list();
    expect(docs.map((d) => d.id)).toEqual(["SHOP-1", "SHOP-2", "SHOP-3"]);
    expect(docs[0]).toMatchObject({ title: "Bug 1", tags: ["component-payments-api"] });
    const jql = new URLSearchParams(fake.requests[0]?.url.search ?? "").get("jql");
    expect(jql).toBe(
      'project = "SHOP" AND issuetype = Bug AND statusCategory = Done AND component = "Pay\\"ments" ORDER BY updated DESC',
    );
  });

  it("REQ-KNOW-12/AC2: Data Center pages with startAt; a bug loads as Markdown with resolution and the last comments", async () => {
    const fake = createFakeFetch([
      {
        match: /^\/rest\/api\/2\/search\?.*startAt=0/,
        reply: jsonReply({ issues: Array.from({ length: 100 }, (_, i) => listed(i + 1)) }),
      },
      { match: /^\/rest\/api\/2\/search\?.*startAt=100/, reply: jsonReply({ issues: [listed(101)] }) },
      {
        match: /^\/rest\/api\/2\/issue\/SHOP-7\?fields=/,
        reply: jsonReply({
          key: "SHOP-7",
          fields: {
            summary: "Refund twice for one order",
            description: "Clicking *Refund* twice sends two refunds.",
            components: [{ name: "Payments API" }],
            resolution: { name: "Fixed" },
            resolutiondate: "2026-08-20T10:00:00.000+0000",
            fixVersions: [{ name: "2.4.1" }],
            comment: {
              comments: [{ author: { displayName: "Dev" }, body: "Root cause: no idempotency key." }],
            },
          },
        }),
      },
    ]);
    const source = createJiraBugSource(
      {
        baseUrl: "https://jira.example.com",
        flavor: "datacenter",
        token: "secret://env/JIRA_TOKEN",
        projectKey: "SHOP",
      },
      testDeps(fake.fetch, SECRETS),
    );
    expect(await source.list()).toHaveLength(101);
    expect(fake.requests[0]?.headers["authorization"]).toBe("Bearer jira-token-value");
    const loaded = await source.load({ id: "SHOP-7", title: "", version: "", modifiedAt: "" });
    expect(loaded.format).toBe("markdown");
    expect(loaded.text).toContain("# SHOP-7 Refund twice for one order");
    expect(loaded.text).toContain("Components: Payments API");
    expect(loaded.text).toContain("Resolution: Fixed (2026-08-20)");
    expect(loaded.text).toContain("Fix versions: 2.4.1");
    expect(loaded.text).toContain("- Dev: Root cause: no idempotency key.");
    await expect(
      source.load({ id: "SHOP-7/../x", title: "", version: "", modifiedAt: "" }),
    ).rejects.toMatchObject({
      code: "JIRA_KEY_INVALID",
    });
    expect(() =>
      createJiraBugSource(
        { baseUrl: "https://j", token: "t", projectKey: "bad key" },
        testDeps(fake.fetch, SECRETS),
      ),
    ).toThrow(/project key/);
  });

  it("REQ-KNOW-12/AC2: ticket files give the same source offline: only resolved bugs, optionally of one component", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qj-bugs-"));
    dirs.push(dir);
    const write = (key: string, t: Record<string, unknown>) =>
      writeFile(join(dir, `${key}.json`), JSON.stringify({ key, summary: key, ...t }));
    await write("DEMO-5", {
      type: "Bug",
      status: "Done",
      components: ["Cart"],
      description: "Total rounded per line.",
    });
    await write("DEMO-6", { type: "Bug", status: "In Progress", components: ["Cart"] });
    await write("DEMO-7", { type: "Story", status: "Done" });
    await write("DEMO-8", { type: "Bug", status: "Closed", components: ["Login"] });
    expect((await createFileBugSource(dir).list()).map((d) => d.id)).toEqual(["DEMO-5", "DEMO-8"]);
    const cart = createFileBugSource(dir, { component: "Cart" });
    const docs = await cart.list();
    expect(docs.map((d) => d.id)).toEqual(["DEMO-5"]);
    expect((await cart.load(docs[0] ?? { id: "", title: "", version: "", modifiedAt: "" })).text).toContain(
      "Total rounded per line.",
    );
    expect(componentTag("Payments API")).toBe("component-payments-api");
  });
});
