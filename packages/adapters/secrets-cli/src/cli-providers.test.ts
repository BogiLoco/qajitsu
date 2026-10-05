import { describe, expect, it } from "vitest";
import { secretProviderContract } from "../../../../tests/contract/secret-provider.contract.js";
import {
  createAwsSecretProvider,
  createGcpSecretProvider,
  createOnePasswordSecretProvider,
  type SecretCliExec,
} from "./cli-providers.js";

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** A fake CLI: answers from a map keyed by the secret's name, records every call. */
const fakeCli = (answer: (args: readonly string[]) => string | undefined) => {
  const calls: Call[] = [];
  const exec: SecretCliExec = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    const out = answer(args);
    return out === undefined ? Promise.reject(new Error(`${command} exited with 1`)) : Promise.resolve(out);
  };
  return { exec, calls };
};
const ENV = {
  PATH: "/usr/bin",
  HOME: "/home/qa",
  OP_SERVICE_ACCOUNT_TOKEN: "ops_fictional",
  AWS_PROFILE: "qa",
  AWS_SECRET_ACCESS_KEY: "aws-fictional",
  CLOUDSDK_CORE_ACCOUNT: "qa@example.com",
  JIRA_TOKEN_IN_PARENT: "must-not-leak",
};

secretProviderContract(
  "op (1Password CLI)",
  (secrets) =>
    createOnePasswordSecretProvider({
      env: ENV,
      exec: fakeCli((args) => secrets[String(args.at(-1)).split("/").at(-1) ?? ""]).exec,
    }),
  "secret://op/QA/jira/",
);
secretProviderContract(
  "aws (Secrets Manager CLI)",
  (secrets) =>
    createAwsSecretProvider({
      region: "eu-central-1",
      env: ENV,
      exec: fakeCli((args) => {
        const v = secrets[args[args.indexOf("--secret-id") + 1] ?? ""];
        return v === undefined ? undefined : `${v}\n`;
      }).exec,
    }),
  "secret://aws/",
);
secretProviderContract(
  "gcp (Secret Manager CLI)",
  (secrets) =>
    createGcpSecretProvider({
      project: "shop-qa",
      env: ENV,
      exec: fakeCli((args) => secrets[(args.find((a) => a.startsWith("--secret=")) ?? "").slice(9)]).exec,
    }),
  "secret://gcp/",
);

describe("secret managers through their CLIs (REQ-CFG-03/AC3)", () => {
  it("REQ-CFG-03/AC3: 1Password runs `op read` with an argument array and only its own variables", async () => {
    const cli = fakeCli(() => "jira-value");
    const op = createOnePasswordSecretProvider({ env: ENV, exec: cli.exec });
    expect(await op.resolve("secret://op/QA Team/Jira cloud/token")).toBe("jira-value");
    expect(cli.calls).toEqual([
      {
        command: "op",
        args: ["read", "--no-newline", "op://QA Team/Jira cloud/token"],
        env: { PATH: "/usr/bin", HOME: "/home/qa", OP_SERVICE_ACCOUNT_TOKEN: "ops_fictional" },
      },
    ]);
  });

  it("REQ-CFG-03/AC3: AWS reads SecretString, optionally one JSON key, in the configured region and profile", async () => {
    const cli = fakeCli(() => '{"username":"qa","password":"aws-secret-value"}\n');
    const aws = createAwsSecretProvider({ region: "eu-central-1", profile: "qa", env: ENV, exec: cli.exec });
    expect(await aws.resolve("secret://aws/shop/ci/jira#password")).toBe("aws-secret-value");
    expect(cli.calls[0]?.args).toEqual([
      "secretsmanager",
      "get-secret-value",
      "--secret-id",
      "shop/ci/jira",
      "--query",
      "SecretString",
      "--output",
      "text",
      "--region",
      "eu-central-1",
      "--profile",
      "qa",
    ]);
    expect(Object.keys(cli.calls[0]?.env ?? {}).sort()).toEqual([
      "AWS_PROFILE",
      "AWS_SECRET_ACCESS_KEY",
      "HOME",
      "PATH",
    ]);
    await expect(aws.resolve("secret://aws/shop/ci/jira#missing")).rejects.toMatchObject({
      code: "SECRET_NOT_FOUND",
    });
  });

  it("REQ-CFG-03/AC3: GCP reads a version (latest by default) of a secret in the configured project", async () => {
    const cli = fakeCli(() => "gcp-value");
    const gcp = createGcpSecretProvider({ project: "shop-qa", env: ENV, exec: cli.exec });
    expect(await gcp.resolve("secret://gcp/jira-token")).toBe("gcp-value");
    expect(await gcp.resolve("secret://gcp/jira-token@3")).toBe("gcp-value");
    expect(cli.calls.map((c) => c.args)).toEqual([
      ["secrets", "versions", "access", "latest", "--secret=jira-token", "--project=shop-qa"],
      ["secrets", "versions", "access", "3", "--secret=jira-token", "--project=shop-qa"],
    ]);
    expect(Object.keys(cli.calls[0]?.env ?? {}).sort()).toEqual(["CLOUDSDK_CORE_ACCOUNT", "HOME", "PATH"]);
  });

  it("REQ-CFG-03/AC3 + security rules: references that could become CLI options or escape are refused before running anything", async () => {
    const cli = fakeCli(() => "x");
    const providers = [
      [
        createOnePasswordSecretProvider({ env: ENV, exec: cli.exec }),
        ["secret://op/-x/item/f", "secret://op/v/i", "secret://op/v/i/f;rm"],
      ],
      [
        createAwsSecretProvider({ region: "eu-central-1", env: ENV, exec: cli.exec }),
        ["secret://aws/--profile", "secret://aws/a b"],
      ],
      [
        createGcpSecretProvider({ project: "p", env: ENV, exec: cli.exec }),
        ["secret://gcp/-x", "secret://gcp/a@b;c", "secret://gcp/a/b"],
      ],
    ] as const;
    for (const [provider, refs] of providers)
      for (const ref of refs)
        await expect(provider.resolve(ref), ref).rejects.toMatchObject({ code: "SECRET_REF_INVALID" });
    expect(cli.calls).toEqual([]);
  });

  it("REQ-CFG-03/AC3 + invariant 8: a failing CLI is reported without its output", async () => {
    const op = createOnePasswordSecretProvider({
      env: ENV,
      exec: () => Promise.reject(new Error("[ERROR] could not read: token ops_fictional expired")),
    });
    const error = await op.resolve("secret://op/QA/jira/token").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "SECRET_SOURCE_UNREADABLE" });
    expect(String(error) + JSON.stringify(error)).not.toContain("ops_fictional");
  });
});
