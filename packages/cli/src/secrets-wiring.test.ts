import { parseProjectConfig } from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import { describe, expect, it } from "vitest";
import { createFakeFetch, jsonReply } from "../../../tests/support/fake-fetch.js";
import { createCliSecretResolver } from "./adapters.js";

const project = (secrets: unknown) => ({
  config: parseProjectConfig({
    project: "demo",
    jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
    secrets,
  }),
  qaDir: "/nonexistent/.qa",
  projectDir: "/nonexistent",
});

describe("secret providers from the project config (REQ-CFG-03/AC3)", () => {
  it("REQ-CFG-03/AC3: configured providers resolve their references; bootstrap tokens come from env and are masked", async () => {
    const fake = createFakeFetch([
      { match: /^\/v1\/kv\/data\/ci$/, reply: jsonReply({ data: { data: { JIRA_TOKEN: "from-vault" } } }) },
      {
        match: /^\/v3\/configs\/config\/secrets\/download\?/,
        reply: jsonReply({ DB_PASSWORD: "from-doppler" }),
      },
    ]);
    const masker = createMasker();
    const calls: string[][] = [];
    const resolve = createCliSecretResolver(
      project({
        vault: { address: "https://vault.example.com", mount: "kv", token: "secret://env/VAULT_TOKEN" },
        doppler: { project: "shop", config: "ci", token: "secret://env/DOPPLER_TOKEN" },
        op: {},
        aws: { region: "eu-central-1" },
        gcp: { project: "shop-qa" },
      }),
      {
        env: {
          VAULT_TOKEN: "vault-bootstrap-token",
          DOPPLER_TOKEN: "doppler-bootstrap-token",
          PATH: "/usr/bin",
        },
        home: "/home/qa",
        now: () => new Date(0),
        random: () => 0,
        fetch: fake.fetch,
        gitExec: () => Promise.resolve({ stdout: "", stderr: "" }),
        secretCliExec: (command, args) => {
          calls.push([command, ...args]);
          return Promise.resolve(`${command}-value`);
        },
      },
      masker,
    );
    expect(await resolve("secret://vault/ci#JIRA_TOKEN")).toBe("from-vault");
    expect(await resolve("secret://doppler/DB_PASSWORD")).toBe("from-doppler");
    expect(await resolve("secret://op/QA/jira/token")).toBe("op-value");
    expect(await resolve("secret://aws/shop/ci")).toBe("aws-value");
    expect(await resolve("secret://gcp/jira-token")).toBe("gcloud-value");
    expect(calls.map((c) => c[0])).toEqual(["op", "aws", "gcloud"]);
    const text = masker.maskText(
      "vault-bootstrap-token doppler-bootstrap-token from-vault from-doppler op-value",
    );
    expect(text).not.toMatch(/bootstrap-token|from-vault|from-doppler|op-value/);
  });

  it("REQ-CFG-03/AC3: providers that are not configured are unknown; bootstrap tokens must be env references", async () => {
    const resolve = createCliSecretResolver(
      project({}),
      {
        env: {},
        home: "/h",
        now: () => new Date(0),
        random: () => 0,
        fetch: globalThis.fetch,
        gitExec: () => Promise.resolve({ stdout: "", stderr: "" }),
      },
      createMasker(),
    );
    await expect(resolve("secret://vault/ci#A")).rejects.toMatchObject({ code: "SECRET_PROVIDER_UNKNOWN" });
    let error: unknown;
    try {
      project({ vault: { address: "https://vault.example.com", token: "secret://vault/root#token" } });
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({
      code: "CONFIG_INVALID",
      context: { issues: [expect.stringContaining("secrets.vault.token") as unknown] },
    });
  });
});
