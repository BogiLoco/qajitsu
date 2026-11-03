import type { DocumentSourceFixture } from "../contract/document-source.contract.js";
import { jsonReply } from "./fake-fetch.js";

/** A Confluence Cloud space with one page, for the DocumentSource contract. */
export const confluenceFixture: DocumentSourceFixture = {
  routes: [
    {
      match: /^\/wiki\/rest\/api\/content\?spaceKey=SHOP&type=page&expand=version&limit=100&start=0$/,
      reply: jsonReply({
        results: [{ id: "7", title: "Refunds", version: { number: 2, when: "2026-09-01T10:00:00.000Z" } }],
      }),
    },
    {
      match: /^\/wiki\/rest\/api\/content\/7\?expand=body\.storage,version$/,
      reply: jsonReply({
        id: "7",
        title: "Refunds",
        version: { number: 2, when: "2026-09-01T10:00:00.000Z" },
        body: { storage: { value: "<p>Refunds within 14 days.</p>" } },
      }),
    },
  ],
  secrets: {
    "secret://env/CONFLUENCE_EMAIL": "qa@example.com",
    "secret://env/CONFLUENCE_TOKEN": "token-value",
  },
  expected: { id: "7", title: "Refunds", text: "Refunds within 14 days." },
};

/** The source configuration matching {@link confluenceFixture}. */
export const confluenceConfig = {
  baseUrl: "https://shop.atlassian.net/wiki",
  flavor: "cloud" as const,
  email: "secret://env/CONFLUENCE_EMAIL",
  token: "secret://env/CONFLUENCE_TOKEN",
  space: "SHOP",
};
