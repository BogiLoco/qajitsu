import { describe, expect, it } from "vitest";
import { createFakeFetch, jsonReply } from "../../../../tests/support/fake-fetch.js";
import { secretProviderContract } from "../../../../tests/contract/secret-provider.contract.js";
import { createDopplerSecretProvider } from "./doppler.js";

const TOKEN = "dp.st.fictional-token";
const doppler = (secrets: Record<string, string>) => {
  const fake = createFakeFetch([
    {
      method: "GET",
      match: /^\/v3\/configs\/config\/secrets\/download\?/,
      reply: (r) =>
        r.headers["authorization"] === `Bearer ${TOKEN}`
          ? jsonReply(secrets)(r)
          : jsonReply({ messages: ["Invalid token"] }, 401)(r),
    },
  ]);
  return {
    fake,
    provider: createDopplerSecretProvider({
      token: () => Promise.resolve(TOKEN),
      project: "shop",
      config: "ci",
      fetch: fake.fetch,
    }),
  };
};

secretProviderContract("doppler", (secrets) => doppler(secrets).provider, "secret://doppler/");

describe("Doppler secret provider (REQ-CFG-03/AC3)", () => {
  it("REQ-CFG-03/AC3: downloads the project config once with the service token and reads names from it", async () => {
    const { provider, fake } = doppler({ JIRA_TOKEN: "jira-value", DB_PASSWORD: "db-value" });
    expect(await provider.resolve("secret://doppler/JIRA_TOKEN")).toBe("jira-value");
    expect(await provider.resolve("secret://doppler/DB_PASSWORD")).toBe("db-value");
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.url.searchParams.get("project")).toBe("shop");
    expect(fake.requests[0]?.url.searchParams.get("config")).toBe("ci");
    expect(fake.requests[0]?.url.searchParams.get("format")).toBe("json");
  });

  it("REQ-CFG-03/AC3 + invariant 8: an invalid token or name fails without the token or values", async () => {
    const bad = createDopplerSecretProvider({
      token: () => Promise.resolve("wrong"),
      project: "shop",
      config: "ci",
      fetch: doppler({}).fake.fetch,
    });
    const error = await bad.resolve("secret://doppler/JIRA_TOKEN").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "SECRET_SOURCE_UNREADABLE" });
    expect(String(error) + JSON.stringify(error)).not.toContain(TOKEN);
    await expect(doppler({}).provider.resolve("secret://doppler/bad-name")).rejects.toMatchObject({
      code: "SECRET_REF_INVALID",
    });
  });
});
