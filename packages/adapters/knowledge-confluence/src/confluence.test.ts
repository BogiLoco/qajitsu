import { describe, expect, it } from "vitest";
import { createFakeFetch, jsonReply, testDeps, type Route } from "../../../../tests/support/fake-fetch.js";
import { createConfluenceSource } from "./confluence.js";

const page = (id: number, version = 1) => ({
  id: String(id),
  title: `Page ${String(id)}`,
  version: { number: version, when: "2026-09-01T10:00:00.000Z" },
});

const SECRETS = {
  "secret://env/CONFLUENCE_EMAIL": "qa@example.com",
  "secret://env/CONFLUENCE_TOKEN": "confluence-token-value",
};

describe("Confluence document source (REQ-KNOW-12/AC1)", () => {
  it("REQ-KNOW-12/AC1: lists a whole space page by page with versions and no bodies; Cloud uses basic auth", async () => {
    const routes: Route[] = [
      {
        match: /^\/wiki\/rest\/api\/content\?spaceKey=SHOP&type=page&expand=version&limit=100&start=0$/,
        reply: jsonReply({ results: Array.from({ length: 100 }, (_, i) => page(i + 1)) }),
      },
      {
        match: /^\/wiki\/rest\/api\/content\?spaceKey=SHOP&type=page&expand=version&limit=100&start=100$/,
        reply: jsonReply({ results: [page(101, 3)] }),
      },
    ];
    const fake = createFakeFetch(routes);
    const source = createConfluenceSource(
      {
        baseUrl: "https://shop.atlassian.net/wiki/",
        flavor: "cloud",
        email: "secret://env/CONFLUENCE_EMAIL",
        token: "secret://env/CONFLUENCE_TOKEN",
        space: "SHOP",
      },
      testDeps(fake.fetch, SECRETS),
    );
    const docs = await source.list();
    expect(docs).toHaveLength(101);
    expect(docs.at(-1)).toEqual({
      id: "101",
      title: "Page 101",
      version: "3",
      modifiedAt: "2026-09-01T10:00:00.000Z",
    });
    expect(fake.requests[0]?.headers["authorization"]).toBe(
      `Basic ${Buffer.from("qa@example.com:confluence-token-value").toString("base64")}`,
    );
    expect(fake.requests.every((r) => !r.url.search.includes("body"))).toBe(true);
  });

  it("REQ-KNOW-12/AC1: a page tree is the page and its descendants; load returns the storage body with the title as heading", async () => {
    const fake = createFakeFetch([
      { match: /^\/rest\/api\/content\/42\?expand=version$/, reply: jsonReply(page(42, 7)) },
      {
        match: /^\/rest\/api\/content\/42\/descendant\/page\?expand=version&limit=100&start=0$/,
        reply: jsonReply({ results: [page(43)] }),
      },
      {
        match: /^\/rest\/api\/content\/43\?expand=body\.storage,version$/,
        reply: jsonReply({
          ...page(43),
          body: { storage: { value: "<h2>Refunds</h2><p>Within 14 days.</p>" } },
        }),
      },
    ]);
    const source = createConfluenceSource(
      {
        baseUrl: "https://confluence.example.com",
        flavor: "datacenter",
        token: "secret://env/CONFLUENCE_TOKEN",
        space: "SHOP",
        page: "42",
      },
      testDeps(fake.fetch, SECRETS),
    );
    const docs = await source.list();
    expect(docs.map((d) => [d.id, d.version])).toEqual([
      ["42", "7"],
      ["43", "1"],
    ]);
    expect(fake.requests[0]?.headers["authorization"]).toBe("Bearer confluence-token-value");
    expect(await source.load({ id: "43", title: "Page 43", version: "1", modifiedAt: "" })).toEqual({
      format: "html",
      text: "<h1>Page 43</h1>\n<h2>Refunds</h2><p>Within 14 days.</p>",
    });
  });

  it("REQ-KNOW-12/AC1: invalid space keys, page ids and missing Cloud e-mail are errors; HTTP errors are not empty results", async () => {
    const fake = createFakeFetch([{ match: /.*/, reply: jsonReply({}, 401) }]);
    const deps = testDeps(fake.fetch, SECRETS);
    const base = {
      baseUrl: "https://c.example.com",
      flavor: "cloud" as const,
      token: "secret://env/CONFLUENCE_TOKEN",
    };
    expect(() => createConfluenceSource({ ...base, space: "../x" }, deps)).toThrow(/space key/);
    expect(() => createConfluenceSource({ ...base, space: "S", page: "1;drop" }, deps)).toThrow(/page id/);
    await expect(createConfluenceSource({ ...base, space: "S" }, deps).list()).rejects.toMatchObject({
      code: "CONFLUENCE_AUTH_MISSING",
    });
    const withEmail = createConfluenceSource(
      { ...base, space: "S", email: "secret://env/CONFLUENCE_EMAIL" },
      deps,
    );
    await expect(withEmail.list()).rejects.toMatchObject({ code: "CONFLUENCE_AUTH" });
    await expect(
      withEmail.load({ id: "x/../y", title: "", version: "1", modifiedAt: "" }),
    ).rejects.toMatchObject({
      code: "CONFLUENCE_PAGE_INVALID",
    });
  });
});
