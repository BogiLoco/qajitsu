import { describe, expect, it } from "vitest";
import type { SecretProvider } from "../interfaces/secret-provider.js";
import { createSecretResolver, parseSecretRef } from "./secret-resolver.js";

const fake: SecretProvider = {
  scheme: "env",
  resolve: (ref) => Promise.resolve(`value-of-${ref.slice(13)}`),
};

describe("secret resolver (REQ-CFG-03)", () => {
  it("REQ-CFG-03/AC1: parses secret://<provider>/<path>", () => {
    expect(parseSecretRef("secret://env/GITHUB_TOKEN")).toEqual({ provider: "env", path: "GITHUB_TOKEN" });
    expect(parseSecretRef("secret://vault/kv/shop/jira")).toEqual({
      provider: "vault",
      path: "kv/shop/jira",
    });
  });

  it("REQ-CFG-03/AC1: rejects plain values without echoing them", () => {
    try {
      parseSecretRef("ghp_plaintexttoken123");
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "SECRET_REF_INVALID" });
      expect(JSON.stringify(error) + String(error)).not.toContain("ghp_plaintexttoken123");
    }
  });

  it("registers every resolved value with the masker before returning it", async () => {
    const registered: string[] = [];
    const resolve = createSecretResolver([fake], (v) => registered.push(v));
    expect(await resolve("secret://env/TOKEN")).toBe("value-of-TOKEN");
    expect(registered).toEqual(["value-of-TOKEN"]);
  });

  it("unknown provider is a configuration error", async () => {
    const resolve = createSecretResolver([fake], () => undefined);
    await expect(resolve("secret://vault/x")).rejects.toMatchObject({ code: "SECRET_PROVIDER_UNKNOWN" });
  });
});
