import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiService, createBuildProject } from "../../../../tests/support/cli-build.js";
import { createFakeEmbedder } from "../../../../tests/support/fake-embedder.js";
import { createFakeFetch, jsonReply } from "../../../../tests/support/fake-fetch.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A Confluence space whose pages and versions the test changes between syncs. */
const confluence = () => {
  const pages = new Map<string, { title: string; version: number; body: string }>([
    [
      "101",
      {
        title: "Refund policy",
        version: 1,
        body: "<h2>Card refunds</h2><p>Refunds reach the card in five working days.</p>",
      },
    ],
    [
      "102",
      { title: "Cart rules", version: 1, body: "<h2>Limits</h2><p>The cart keeps at most twenty items.</p>" },
    ],
  ]);
  const meta = (id: string) => {
    const p = pages.get(id);
    return {
      id,
      title: p?.title ?? "",
      version: { number: p?.version ?? 0, when: "2026-09-01T10:00:00.000Z" },
    };
  };
  const fake = createFakeFetch([
    {
      match: /^\/rest\/api\/content\?spaceKey=SHOP&type=page&expand=version/,
      reply: (req) => jsonReply({ results: [...pages.keys()].map(meta) })(req),
    },
    {
      match: /^\/rest\/api\/content\/(\d+)\?expand=body\.storage,version$/,
      reply: (req) => {
        const id = /content\/(\d+)/.exec(req.url.pathname)?.[1] ?? "";
        return jsonReply({ ...meta(id), body: { storage: { value: pages.get(id)?.body ?? "" } } })(req);
      },
    },
  ]);
  const bodies = () =>
    fake.requests
      .filter((r) => r.url.search.includes("body.storage"))
      .map((r) => /content\/(\d+)/.exec(r.url.pathname)?.[1]);
  return { pages, fake, bodies };
};

const setup = async () => {
  const space = confluence();
  const embedder = createFakeEmbedder();
  const p = await createBuildProject(apiService(), {
    ports: { embedder: (ref) => Promise.resolve({ ...embedder, id: ref }), fetch: space.fake.fetch },
  });
  cleanups.push(p.cleanup);
  const yaml = join(p.project, ".qa", "qa.project.yaml");
  const configure = async (line: string) => writeFile(yaml, `${await readFile(yaml, "utf8")}\n${line}\n`);
  return { ...p, space, configure, env: { CONFLUENCE_TOKEN: "confluence-pat-value" } };
};

describe("online knowledge sources (REQ-KNOW-12)", () => {
  it("REQ-KNOW-12/AC1: a Confluence space is added and synced incrementally by page version", async () => {
    const p = await setup();
    expect((await p.run(["knowledge", "add", "confluence:SHOP"], undefined, { env: p.env })).err).toContain(
      "[KNOWLEDGE_CONFLUENCE_NOT_CONFIGURED]",
    );
    await p.configure(
      "knowledge: { confluence: { base_url: https://confluence.example.com, type: datacenter, token: secret://env/CONFLUENCE_TOKEN } }",
    );
    const added = await p.run(["knowledge", "add", "confluence:SHOP"], undefined, { env: p.env });
    expect(added.err).toBe("");
    expect(added.out).toContain("2 added, 0 updated, 0 unchanged");
    expect(p.space.bodies().sort()).toEqual(["101", "102"]);
    const found = await p.run(["knowledge", "search", "refund card working days"], undefined, { env: p.env });
    expect(found.out).toMatch(/\d\. confluence-shop\/101 › Refund policy > Card refunds \(2026-09-01\)/);
    // Only the page whose version changed is downloaded again; a deleted page leaves the knowledge base.
    const page = p.space.pages.get("102");
    if (page)
      Object.assign(page, { version: 2, body: "<h2>Limits</h2><p>The cart keeps at most thirty items.</p>" });
    p.space.pages.set("103", {
      title: "Login",
      version: 1,
      body: "<p>Three failed logins lock the account.</p>",
    });
    p.space.pages.delete("101");
    const before = p.space.bodies().length;
    const synced = await p.run(["knowledge", "sync"], undefined, { env: p.env });
    expect(synced.out).toContain("1 added, 1 updated, 0 unchanged, 0 skipped, 1 removed");
    expect(p.space.bodies().slice(before).sort()).toEqual(["102", "103"]);
    expect((await p.run(["knowledge", "search", "cart items"], undefined, { env: p.env })).out).toContain(
      "thirty items",
    );
    expect((await p.run(["knowledge", "search", "refund"], undefined, { env: p.env })).out).not.toContain(
      "confluence-shop/101",
    );
    // A removed page stays out on the next sync.
    expect(
      (await p.run(["knowledge", "remove", "confluence-shop/103"], undefined, { env: p.env })).out,
    ).toContain("excluded from source confluence-shop");
    expect((await p.run(["knowledge", "sync"], undefined, { env: p.env })).out).toContain("0 added");
    const all = [added, found, synced].map((r) => r.out + r.err).join("");
    expect(all).not.toContain("confluence-pat-value");
    expect(p.space.fake.requests[0]?.headers["authorization"]).toBe("Bearer confluence-pat-value");
  }, 120_000);

  it("REQ-KNOW-12/AC2: resolved bugs of a component become regression knowledge, tagged by component", async () => {
    const p = await setup();
    const tickets = join(p.project, "tickets");
    await writeFile(
      join(tickets, "DEMO-5.json"),
      JSON.stringify({
        key: "DEMO-5",
        type: "Bug",
        status: "Done",
        summary: "Cart total rounded per line",
        description: "Rounding each line before summing gave 1.02 instead of 1.01.",
        components: ["Cart"],
        updated: "2026-08-01T10:00:00.000Z",
        comments: [{ author: "dev", body: "Root cause: Math.round per line." }],
      }),
    );
    await writeFile(
      join(tickets, "DEMO-6.json"),
      JSON.stringify({
        key: "DEMO-6",
        type: "Bug",
        status: "Done",
        summary: "Login lockout",
        components: ["Login"],
      }),
    );
    const added = await p.run(["knowledge", "add", "jira:bugs/Cart"]);
    expect(added.err).toBe("");
    expect(added.out).toContain("1 added");
    const found = await p.run(["knowledge", "search", "rounded per line", "--tag", "component-cart"]);
    expect(found.out).toMatch(/\d\. jira-bugs-cart\/DEMO-5 › DEMO-5 Cart total rounded per line/);
    expect(found.out).not.toContain("DEMO-6");
    expect((await p.run(["knowledge", "add", "jira:issues"])).err).toContain("[KNOWLEDGE_LOCATOR_INVALID]");
    expect((await p.run(["knowledge", "list"])).out).toContain("jira-bugs-cart  jira:bugs/Cart  1 file(s)");
  }, 120_000);
});
