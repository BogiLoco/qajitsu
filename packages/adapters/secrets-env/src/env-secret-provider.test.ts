import { describe, expect, it } from "vitest";
import { secretProviderContract } from "../../../../tests/contract/secret-provider.contract.js";
import { createEnvSecretProvider, parseDotenv } from "./env-secret-provider.js";

secretProviderContract("env", (secrets) => createEnvSecretProvider({ env: secrets }), "secret://env/");

describe("env secret provider (REQ-CFG-03/AC2)", () => {
  const fileText =
    'export FROM_FILE="line1\\nline2"\n# comment\nBOTH=file\nSPACED = plain value # trailing\nBAD-KEY=x\nnoequals\n';

  it("REQ-CFG-03/AC2: reads .env.local and lets the process environment win", async () => {
    const provider = createEnvSecretProvider({
      env: { BOTH: "process" },
      envFile: "/x/.env.local",
      readText: () => Promise.resolve(fileText),
    });
    expect(await provider.resolve("secret://env/FROM_FILE")).toBe("line1\nline2");
    expect(await provider.resolve("secret://env/BOTH")).toBe("process");
    expect(await provider.resolve("secret://env/SPACED")).toBe("plain value");
  });

  it("missing .env.local is fine; unreadable is an adapter error", async () => {
    const missing = createEnvSecretProvider({
      env: {},
      envFile: "/x/.env.local",
      readText: () => Promise.reject(Object.assign(new Error("no"), { code: "ENOENT" })),
    });
    await expect(missing.resolve("secret://env/A")).rejects.toMatchObject({ code: "SECRET_NOT_FOUND" });
    const broken = createEnvSecretProvider({
      env: {},
      envFile: "/x/.env.local",
      readText: () => Promise.reject(Object.assign(new Error("no"), { code: "EACCES" })),
    });
    await expect(broken.resolve("secret://env/A")).rejects.toMatchObject({
      code: "SECRET_SOURCE_UNREADABLE",
    });
  });

  it("rejects references for other providers or invalid names", async () => {
    const provider = createEnvSecretProvider({ env: {} });
    await expect(provider.resolve("secret://vault/A")).rejects.toMatchObject({ code: "SECRET_REF_INVALID" });
    await expect(provider.resolve("secret://env/a/b")).rejects.toMatchObject({ code: "SECRET_REF_INVALID" });
  });

  it("parses single quotes literally", () => {
    expect(parseDotenv("A='x\\ny'\nB=")).toEqual({ A: "x\\ny", B: "" });
  });
});
