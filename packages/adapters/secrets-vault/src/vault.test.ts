import { describe, expect, it } from "vitest";
import { createFakeFetch, jsonReply } from "../../../../tests/support/fake-fetch.js";
import { secretProviderContract } from "../../../../tests/contract/secret-provider.contract.js";
import { createVaultSecretProvider } from "./vault.js";

const TOKEN = "fictional-vault-token";
const vault = (secrets: Record<string, string>, extra: { address?: string; namespace?: string } = {}) => {
  const fake = createFakeFetch([
    {
      method: "GET",
      match: /^\/v1\/kv\/data\/ci\/qajitsu$/,
      reply: (r) =>
        r.headers["x-vault-token"] === TOKEN
          ? jsonReply({ data: { data: secrets, metadata: { version: 3 } } })(r)
          : jsonReply({ errors: ["permission denied"] }, 403)(r),
    },
    { method: "GET", match: /^\/v1\/kv\/data\//, reply: jsonReply({ errors: [] }, 404) },
  ]);
  const provider = createVaultSecretProvider({
    address: extra.address ?? "https://vault.example.com",
    mount: "kv",
    token: () => Promise.resolve(TOKEN),
    fetch: fake.fetch,
    ...(extra.namespace ? { namespace: extra.namespace } : {}),
  });
  return { provider, fake };
};

secretProviderContract("vault", (secrets) => vault(secrets).provider, "secret://vault/ci/qajitsu#");

describe("Vault secret provider (REQ-CFG-03/AC3)", () => {
  it("REQ-CFG-03/AC3: reads a field of a KV v2 secret with the token header, once per path", async () => {
    const { provider, fake } = vault(
      { JIRA_TOKEN: "jira-value", GITHUB_TOKEN: "gh-value" },
      { namespace: "qa" },
    );
    expect(await provider.resolve("secret://vault/ci/qajitsu#JIRA_TOKEN")).toBe("jira-value");
    expect(await provider.resolve("secret://vault/ci/qajitsu#GITHUB_TOKEN")).toBe("gh-value");
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.headers).toMatchObject({ "x-vault-token": TOKEN, "x-vault-namespace": "qa" });
  });

  it("REQ-CFG-03/AC3 + invariant 8: missing secrets, missing fields and denied access fail without values or the token", async () => {
    const { provider } = vault({ A: "value-a" });
    for (const ref of [
      "secret://vault/other/path#A",
      "secret://vault/ci/qajitsu#B",
      "secret://vault/ci/qajitsu",
    ]) {
      const error = await provider.resolve(ref).catch((e: unknown) => e);
      expect(error, ref).toMatchObject({
        code: expect.stringMatching(/^SECRET_(NOT_FOUND|REF_INVALID)$/) as unknown,
      });
      expect(JSON.stringify(error) + String(error)).not.toMatch(/value-a|fictional-vault-token/);
    }
    const denied = createVaultSecretProvider({
      address: "https://vault.example.com",
      mount: "kv",
      token: () => Promise.resolve("wrong-token"),
      fetch: createFakeFetch([{ match: /./, reply: jsonReply({ errors: ["permission denied"] }, 403) }])
        .fetch,
    });
    await expect(denied.resolve("secret://vault/ci/qajitsu#A")).rejects.toMatchObject({
      code: "SECRET_SOURCE_UNREADABLE",
    });
  });

  it("REQ-CFG-03/AC3: refuses plain HTTP to a remote Vault and path traversal", async () => {
    expect(() => vault({}, { address: "http://vault.example.com" })).toThrow(/https/);
    expect(() => vault({}, { address: "http://127.0.0.1:8200" })).not.toThrow();
    await expect(vault({}).provider.resolve("secret://vault/../sys/seal#x")).rejects.toMatchObject({
      code: "SECRET_REF_INVALID",
    });
  });
});
