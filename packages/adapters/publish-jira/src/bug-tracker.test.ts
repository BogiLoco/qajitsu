import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeFetch, jsonReply, testDeps } from "../../../../tests/support/fake-fetch.js";
import { createFileBugTracker, createJiraBugTracker } from "./bug-tracker.js";

const SECRETS = {
  "secret://env/JIRA_EMAIL": "qa@example.com",
  "secret://env/JIRA_TOKEN": "jira-token-value",
};
const draft = {
  project: "SHOP",
  summary: "Cart total is rounded once: S1 fields.total expected 1.01 but was 1.02",
  description: { adf: { version: 1, type: "doc", content: [] }, wiki: "h4. Found by", text: "Found by" },
  components: ["Cart"],
  labels: ["qajitsu"],
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("Jira bug tracker (REQ-PUB-07)", () => {
  it("REQ-PUB-07/AC1: searches open bugs of the project and components by summary words, quoted and without operators", async () => {
    const fake = createFakeFetch([
      {
        match: /^\/rest\/api\/3\/search\/jql\?/,
        reply: jsonReply({
          issues: [
            {
              key: "SHOP-77",
              fields: { summary: "Cart total wrong after rounding", status: { name: "Open" } },
            },
          ],
        }),
      },
    ]);
    const tracker = createJiraBugTracker(
      {
        flavor: "cloud",
        baseUrl: "https://shop.atlassian.net",
        email: "secret://env/JIRA_EMAIL",
        token: "secret://env/JIRA_TOKEN",
      },
      testDeps(fake.fetch, SECRETS),
    );
    const matches = await tracker.findSimilar({
      project: "SHOP",
      components: ["Cart"],
      words: ["cart", "total", 'x") OR (1=1', "ro"],
    });
    expect(matches).toEqual([
      {
        key: "SHOP-77",
        summary: "Cart total wrong after rounding",
        status: "Open",
        url: "https://shop.atlassian.net/browse/SHOP-77",
      },
    ]);
    expect(new URLSearchParams(fake.requests[0]?.url.search ?? "").get("jql")).toBe(
      'project = "SHOP" AND issuetype = Bug AND statusCategory != Done AND (summary ~ "cart" OR summary ~ "total") AND component in ("Cart") ORDER BY updated DESC',
    );
    expect(await tracker.findSimilar({ project: "SHOP", components: [], words: ["a", "!!"] })).toEqual([]);
  });

  it("REQ-PUB-07/AC4: creates a Bug with wiki markup on Data Center and links it to the tested ticket", async () => {
    const fake = createFakeFetch([
      {
        method: "POST",
        match: /^\/rest\/api\/2\/issue$/,
        reply: jsonReply({ id: "100", key: "SHOP-90" }, 201),
      },
      {
        method: "POST",
        match: /^\/rest\/api\/2\/issueLink$/,
        reply: () => new Response(null, { status: 201 }),
      },
    ]);
    const tracker = createJiraBugTracker(
      { flavor: "datacenter", baseUrl: "https://jira.example.com", token: "secret://env/JIRA_TOKEN" },
      testDeps(fake.fetch, SECRETS),
    );
    expect(await tracker.createBug(draft)).toEqual({
      key: "SHOP-90",
      url: "https://jira.example.com/browse/SHOP-90",
    });
    expect(JSON.parse(fake.requests[0]?.body ?? "{}")).toEqual({
      fields: {
        project: { key: "SHOP" },
        issuetype: { name: "Bug" },
        summary: draft.summary,
        description: "h4. Found by",
        labels: ["qajitsu"],
        components: [{ name: "Cart" }],
      },
    });
    await tracker.link("SHOP-90", "SHOP-482");
    expect(JSON.parse(fake.requests[1]?.body ?? "{}")).toEqual({
      type: { name: "Relates" },
      inwardIssue: { key: "SHOP-90" },
      outwardIssue: { key: "SHOP-482" },
    });
    await expect(tracker.link("SHOP-90", "x")).rejects.toMatchObject({ code: "JIRA_KEY_INVALID" });
    await expect(
      tracker.findSimilar({ project: "bad key", components: [], words: ["cart"] }),
    ).rejects.toMatchObject({
      code: "JIRA_PROJECT_INVALID",
    });
  });

  it("REQ-PUB-07/AC1+AC4: the file tracker finds open bugs in ticket files and writes new bugs and links", async () => {
    const tickets = await mkdtemp(join(tmpdir(), "qj-tickets-"));
    const out = await mkdtemp(join(tmpdir(), "qj-bugs-"));
    dirs.push(tickets, out);
    await writeFile(
      join(tickets, "DEMO-7.json"),
      JSON.stringify({ key: "DEMO-7", type: "Bug", status: "Open", summary: "Cart total off by a cent" }),
    );
    await writeFile(
      join(tickets, "DEMO-8.json"),
      JSON.stringify({ key: "DEMO-8", type: "Bug", status: "Done", summary: "Cart total" }),
    );
    const tracker = createFileBugTracker(tickets, out);
    expect(await tracker.findSimilar({ project: "DEMO", components: [], words: ["total"] })).toEqual([
      { key: "DEMO-7", summary: "Cart total off by a cent", status: "Open" },
    ]);
    expect((await tracker.createBug({ ...draft, project: "DEMO" })).key).toBe("DEMO-9001");
    await tracker.link("DEMO-9001", "DEMO-1");
    expect((await readdir(out)).sort()).toEqual(["DEMO-9001.json", "link-DEMO-9001-DEMO-1.json"]);
    expect(JSON.parse(await readFile(join(out, "DEMO-9001.json"), "utf8"))).toMatchObject({
      key: "DEMO-9001",
      summary: draft.summary,
    });
  });
});
