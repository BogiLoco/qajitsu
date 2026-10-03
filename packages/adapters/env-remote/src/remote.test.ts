import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectConfig, resolveEnvironment } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { startShop } from "../../../../examples/demo-shop/api/server.mjs";
import { checkHealth, compareDeployedSha, loginAccounts, readDeployedSha } from "./remote.js";

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
    const { qaDir, config } = await project(
      profileFor("https://staging.example.com", "production: true\n"),
      {},
      [],
    );
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
});
