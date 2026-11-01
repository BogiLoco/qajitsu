import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startShop } from "../../../../examples/demo-shop/api/server.mjs";
import { createCliProject, gitExec } from "../../../../tests/support/cli-project.js";
import { createProgram } from "../program.js";

const PASSWORD = "fictional-demo-password";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const setup = async (testData = true) => {
  const shop = await startShop({ env: { DEMO_USER_PASSWORD: PASSWORD } });
  const { home, project } = await createCliProject();
  cleanups.push(
    () => shop.close(),
    () => rm(home, { recursive: true, force: true }),
  );
  const yaml = join(project, ".qa", "qa.project.yaml");
  await writeFile(
    yaml,
    `${(await readFile(yaml, "utf8")).replace(
      "environments: { allowlist: ['http://localhost:3000'] }",
      `environments: { default: local, allowlist: ['${shop.url}'] }`,
    )}\n${
      testData
        ? 'test_data:\n  cleanup: { request: "DELETE /admin/products?marker={marker}", as: "user:admin" }\n'
        : ""
    }`,
  );
  await mkdir(join(project, ".qa", "envs"));
  await writeFile(
    join(project, ".qa", "envs", "local.yaml"),
    `base_url: ${shop.url}\naccounts:\n  user:admin: { username: admin, password: secret://env/DEMO_USER_PASSWORD }\nlogin:\n  path: /auth/login\n  body: { username: "{{username}}", password: "{{password}}" }\n  token_path: token\n`,
  );
  const run = async (args: string[]) => {
    let out = "";
    let err = "";
    let exitCode = 0;
    await createProgram("1.0.0", {
      write: (t) => (out += t),
      writeError: (t) => (err += t),
      cwd: project,
      nodeVersion: "v22.22.0",
      setExitCode: (c) => (exitCode = c),
      user: "qa-lead",
      ports: {
        env: { DEMO_USER_PASSWORD: PASSWORD },
        home,
        now: () => new Date("2026-10-31T10:00:00Z"),
        random: () => 0,
        fetch: globalThis.fetch,
        gitExec,
      },
    })
      .exitOverride()
      .parseAsync(["node", "qj", ...args]);
    return { out, err, exitCode };
  };
  const login = (await (
    await fetch(`${shop.url}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: PASSWORD }),
    })
  ).json()) as { token: string };
  const admin = login.token;
  const product = (marker: string) =>
    fetch(`${shop.url}/admin/products`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin}` },
      body: JSON.stringify({ name: "Left over", stock: 1, qa_marker: marker }),
    });
  return { run, product };
};

describe("qj data clean (REQ-EXEC-53/AC2)", () => {
  it("REQ-EXEC-53/AC2: removes the test data a crashed run left, by its marker, and only that", async () => {
    const { run, product } = await setup();
    await product("qj-DEMO-17-20261030-1200-abcd-TC-01-a1");
    await product("qj-DEMO-17-20261030-1200-abcd-TC-02-a1");
    await product("qj-DEMO-17-20261031-0900-zzzz-TC-01-a1");
    await product("qj-DEMO-16-20261030-1200-abcd-TC-01-a1");
    const one = await run(["data", "clean", "DEMO-17", "--run", "20261030-1200-abcd"]);
    expect(one.err).toBe("");
    expect(one.out).toContain(
      "Removed the test data marked qj-DEMO-17-20261030-1200-abcd* in local: 2 record(s)",
    );
    expect((await run(["data", "clean", "DEMO-17"])).out).toContain(
      "marked qj-DEMO-17-* in local: 1 record(s)",
    );
    expect((await run(["data", "clean", "--all"])).out).toContain("marked qj-* in local: 1 record(s)");
  });

  it("REQ-EXEC-53/AC2: without a cleanup request or a scope the command says what to do", async () => {
    const { run } = await setup(false);
    expect((await run(["data", "clean", "--all"])).err).toContain("[TEST_DATA_NO_CLEANUP]");
    expect((await run(["data", "clean"])).err).toContain("[DATA_CLEAN_SCOPE]");
    expect((await run(["data", "clean", "DEMO-17", "--run", "nope"])).err).toContain(
      "[TEST_DATA_NO_CLEANUP]",
    );
  });
});
