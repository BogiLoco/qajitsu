import type { TestCaseSourceFixture } from "../contract/test-case-source.contract.js";
import { jsonReply } from "./fake-fetch.js";

/** Xray Cloud with two tests linked to SHOP-482, for the TestCaseSource contract. */
export const xrayFixture: TestCaseSourceFixture = {
  routes: [
    { method: "POST", match: /^\/api\/v2\/authenticate$/, reply: jsonReply('"xray-token-abc"') },
    {
      method: "POST",
      match: /^\/api\/v2\/graphql$/,
      reply: jsonReply({
        data: {
          getTests: {
            total: 2,
            results: [
              {
                jira: { key: "SHOP-101", summary: "Discount applied" },
                steps: [{ action: "Add code SAVE10", data: "SAVE10", result: "Total -10%" }],
              },
              { jira: { key: "SHOP-102", summary: "Gherkin" }, steps: [], gherkin: "Given a cart" },
            ],
          },
        },
      }),
    },
  ],
  secrets: { "secret://env/XRAY_ID": "xray-client-id-1", "secret://env/XRAY_SECRET": "xray-client-secret-1" },
  ticket: "SHOP-482",
  expectedIds: ["xray:SHOP-101", "xray:SHOP-102"],
};

/** The source configuration matching {@link xrayFixture}. */
export const xrayConfig = {
  baseUrl: "https://xray.example.com",
  clientId: "secret://env/XRAY_ID",
  clientSecret: "secret://env/XRAY_SECRET",
};
