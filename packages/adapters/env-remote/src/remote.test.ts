import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectConfig, resolveEnvironment } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { startShop } from "../../../../examples/demo-shop/api/server.mjs";
import { envProviderContract } from "../../../../tests/contract/env-provider.contract.js";
import {
  checkHealth,
  compareDeployedSha,
  createRemoteEnvProvider,
  loginAccounts,
  readDeployedSha,
} from "./remote.js";

const PASSWORD = "fictional-demo-password";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const project = async (profile: string, extra: Record<string, unknown> = {}, allow: string[] = []) => {
  const qaDir = await mkdtemp(join(tmpdir(), "qj-env-"));
  cleanups.push(() => rm(qaDir, { recursive: true, force: true }));
  await mkdir(join(qaDir, "envs"));
  await writeFile(join(qaDir, "envs", "local.yaml"), profile);
  const config = parseProjectConfig({
    project: "demo",
    jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
    environments: { default: "local", allowlist: allow, ...extra },
  });
  return { qaDir, config };
};

const profileFor = (url: string, more = "") =>
  `base_url: ${url}\nversion_path: /version\naccounts:\n  user:standard: { username: standard, password: secret://env/DEMO_USER_PASSWORD }\nlogin:\n  path: /auth/login\n  body: { username: "{{username}}", password: "{{password}}" }\n  token_path: token\n${more}`;

envProviderContract(
  "remote",
  async () => {
    const shop = await startShop({ env: { DEMO_USER_PASSWORD: PASSWORD, DEMO_SHA: "abc1234" } });
    const { qaDir, config } = await project(profileFor(shop.url), {}, [shop.url]);
    const env = await resolveEnvironment({ config, qaDir });
    return { provider: createRemoteEnvProvider(env, fetch), cleanup: () => shop.close() };
  },
  async () => {
    const { qaDir, config } = await project(profileFor("http://127.0.0.1:9"), {}, ["http://127.0.0.1:9"]);
    const env = await resolveEnvironment({ config, qaDir });
    return { provider: createRemoteEnvProvider(env, fetch), cleanup: () => Promise.resolve() };
  },
  false,
);

describe("provided environment (REQ-ENV-01, REQ-ENV-02, REQ-ENV-07, REQ-CFG-07)", () => {
  it("REQ-ENV-07/AC1 + REQ-ENV-01/AC3: uses environments.default; accounts and URLs come from the profile", async () => {
    const shop = await startShop({ env: { DEMO_USER_PASSWORD: PASSWORD, DEMO_SHA: "ABCDEF1234" } });
    cleanups.push(() => shop.close());
    const { qaDir, config } = await project(profileFor(shop.url), {}, [shop.url]);
    const env = await resolveEnvironment({ config, qaDir });
    expect(env).toMatchObject({ name: "local", baseUrl: shop.url, versionPath: "/version" });
    expect(await checkHealth(env, fetch)).toEqual({ ok: true, detail: "HTTP 200" });
    expect(await readDeployedSha(env, fetch)).toBe("abcdef1234");
    const registered: string[] = [];
    const { accounts, secrets } = await loginAccounts(env, {
      fetch,
      resolveSecret: () => Promise.resolve(PASSWORD),
      registerSecret: (v) => registered.push(v),
    });
    expect(accounts["user:standard"]?.["authorization"]).toMatch(/^Bearer [0-9a-f]{32}$/);
    expect(secrets).toContain(PASSWORD);
    expect(registered).toHaveLength(1);
  });

  it("REQ-ENV-01/AC1: an unreachable environment fails the health check", async () => {
    const { qaDir, config } = await project(profileFor("http://127.0.0.1:9"), {}, ["http://127.0.0.1:9"]);
    const env = await resolveEnvironment({ config, qaDir });
    expect((await checkHealth(env, fetch)).ok).toBe(false);
    expect(await readDeployedSha(env, fetch)).toBeUndefined();
    await expect(
      loginAccounts(env, {
        fetch,
        resolveSecret: () => Promise.resolve("x"),
        registerSecret: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "ENV_LOGIN_FAILED" });
  });

  it("REQ-ENV-01/AC2: the allowlist applies and production is denied by default", async () => {
    const a = await project(profileFor("https://shop.example.com"), {}, ["https://staging.example.com"]);
    await expect(resolveEnvironment({ config: a.config, qaDir: a.qaDir })).rejects.toMatchObject({
      code: "ENV_NOT_ALLOWED",
    });
    const b = await project(profileFor("https://shop.example.com", "production: true\n"), {}, [
      "https://shop.example.com",
    ]);
    await expect(resolveEnvironment({ config: b.config, qaDir: b.qaDir })).rejects.toMatchObject({
      code: "ENV_PRODUCTION_DENIED",
    });
    const c = await project(
      profileFor("https://shop.example.com", "production: true\n"),
      { allow_production: true },
      ["https://shop.example.com"],
    );
    expect((await resolveEnvironment({ config: c.config, qaDir: c.qaDir })).name).toBe("local");
  });

  it("REQ-ENV-01: --env <url> keeps the default profile's other settings; REQ-ENV-07/AC2: no default is an error", async () => {
    const { qaDir, config } = await project(profileFor("http://127.0.0.1:3000"), {}, [
      "http://127.0.0.1:3000",
      "http://127.0.0.1:4000",
    ]);
    const env = await resolveEnvironment({ config, qaDir, env: "http://127.0.0.1:4000" });
    expect(env).toMatchObject({
      baseUrl: "http://127.0.0.1:4000",
      profile: { accounts: { "user:standard": { username: "standard" } } },
    });
    const none = parseProjectConfig({
      project: "demo",
      jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
    });
    await expect(resolveEnvironment({ config: none, qaDir })).rejects.toMatchObject({
      code: "ENV_NOT_SELECTED",
    });
    await expect(resolveEnvironment({ config, qaDir, env: "../../etc" })).rejects.toMatchObject({
      code: "ENV_PROFILE_INVALID",
    });
    await expect(resolveEnvironment({ config, qaDir, env: "missing" })).rejects.toMatchObject({
      code: "ENV_PROFILE_INVALID",
    });
  });

  it("REQ-ENV-03 + REQ-CTX-04/AC4: a built environment uses the profile's accounts with its own loopback URL", async () => {
    const prod = await project(profileFor("https://shop.example.com", "production: true\n"), {}, []);
    // A production profile's accounts must not log in to the built code unless production is allowed.
    await expect(
      resolveEnvironment({ config: prod.config, qaDir: prod.qaDir, buildBaseUrl: "http://127.0.0.1:41234" }),
    ).rejects.toMatchObject({ code: "ENV_PRODUCTION_DENIED" });
    const { qaDir, config } = await project(profileFor("https://staging.example.com"), {}, []);
    const env = await resolveEnvironment({ config, qaDir, buildBaseUrl: "http://127.0.0.1:41234" });
    expect(env).toMatchObject({
      name: "build (local)",
      baseUrl: "http://127.0.0.1:41234",
      origin: "http://127.0.0.1:41234",
      profile: { production: false, accounts: { "user:standard": { username: "standard" } } },
    });
    await expect(
      resolveEnvironment({ config, qaDir, buildBaseUrl: "http://10.0.0.5:8080" }),
    ).rejects.toMatchObject({ code: "ENV_NOT_ALLOWED" });
    const bare = parseProjectConfig({
      project: "demo",
      jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
    });
    expect(
      await resolveEnvironment({ config: bare, qaDir, buildBaseUrl: "http://127.0.0.1:5000" }),
    ).toMatchObject({
      name: "build",
      baseUrl: "http://127.0.0.1:5000",
    });
  });

  it("REQ-CFG-07/AC1: account passwords must be secret references", async () => {
    const { qaDir, config } = await project(
      "base_url: http://127.0.0.1:3000\naccounts:\n  user:standard: { username: standard, password: hunter2 }\n",
      {},
      ["http://127.0.0.1:3000"],
    );
    await expect(resolveEnvironment({ config, qaDir })).rejects.toMatchObject({
      code: "ENV_PROFILE_INVALID",
    });
  });

  it("REQ-ENV-02/AC1: compares deployed and analysed SHAs, prefixes included", () => {
    expect(compareDeployedSha("abc1234", ["abc1234ffff"])).toBe("match");
    expect(compareDeployedSha("def5678", ["abc1234ffff"])).toBe("mismatch");
    expect(compareDeployedSha(undefined, ["abc"])).toBe("unknown");
  });

  describe("login script from .qa/auth/ (REQ-GEN-01/AC2)", () => {
    const scriptProfile = (script: string) =>
      `base_url: http://localhost:3000\naccounts:\n  user:standard: { username: standard, password: secret://env/DEMO_USER_PASSWORD }\nlogin: { script: ${script} }\n`;
    const withScript = async (body: string, script = "auth/login.mjs") => {
      const { qaDir, config } = await project(scriptProfile(script), {}, ["http://localhost:3000"]);
      await mkdir(join(qaDir, "auth"));
      await writeFile(join(qaDir, "auth", "login.mjs"), body);
      return { qaDir, env: await resolveEnvironment({ config, qaDir }) };
    };
    const deps = (qaDir: string, registered: string[]) => ({
      fetch,
      qaDir,
      resolveSecret: () => Promise.resolve(PASSWORD),
      registerSecret: (v: string) => {
        registered.push(v);
      },
    });

    it("REQ-GEN-01/AC2 + REQ-CFG-07/AC2: the script logs the alias in and its headers become the session; values are masked", async () => {
      const { qaDir, env } = await withScript(
        `const { QAJITSU_ALIAS, QAJITSU_USERNAME, QAJITSU_PASSWORD, BASE_URL } = process.env;
process.stdout.write(JSON.stringify({
  headers: { cookie: "sid=" + QAJITSU_USERNAME + "-" + QAJITSU_PASSWORD.length },
  session: "tok-" + QAJITSU_ALIAS + "@" + BASE_URL,
}));`,
      );
      const registered: string[] = [];
      const result = await loginAccounts(env, deps(qaDir, registered));
      expect(result.accounts).toEqual({ "user:standard": { cookie: "sid=standard-23" } });
      expect(result.sessions).toEqual({ "user:standard": "tok-user:standard@http://localhost:3000" });
      expect(registered).toEqual(
        expect.arrayContaining(["sid=standard-23", "tok-user:standard@http://localhost:3000"]),
      );
      expect(result.secrets).toEqual(expect.arrayContaining([PASSWORD, "sid=standard-23"]));
    });

    it("REQ-GEN-01/AC2: a failing or malformed script fails the login without its output or the password", async () => {
      for (const body of [
        `console.error("bad password ${PASSWORD}"); process.exit(1);`,
        `process.stdout.write("not json ${PASSWORD}");`,
        `process.stdout.write(JSON.stringify({ headers: { "bad header": "x" } }));`,
      ]) {
        const { qaDir, env } = await withScript(body);
        const error = await loginAccounts(env, deps(qaDir, [])).catch((e: unknown) => e);
        expect(error, body).toMatchObject({ code: "ENV_LOGIN_FAILED" });
        expect(JSON.stringify(error) + String(error)).not.toContain(PASSWORD);
      }
    });

    it("REQ-GEN-01/AC2: login scripts must live in .qa/auth/", async () => {
      for (const script of ["../evil.mjs", "auth/../../evil.mjs", "/tmp/x.mjs", "hooks/login.mjs"]) {
        const { qaDir, config } = await project(scriptProfile(script), {}, ["http://localhost:3000"]);
        await expect(resolveEnvironment({ config, qaDir }), script).rejects.toMatchObject({
          code: "ENV_PROFILE_INVALID",
        });
      }
    });
  });
});
