import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseProjectConfig } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { gitExec } from "../../../../tests/support/cli-project.js";
import { createProgram } from "../program.js";
import { codeHostFromRemote, detectProject } from "./init.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** An unrelated project: a web shop with a GitHub remote, a compose file and an OpenAPI document. */
const otherProject = async () => {
  const home = await mkdtemp(join(tmpdir(), "qj-init-"));
  dirs.push(home);
  const repo = join(home, "work", "Pet-Clinic");
  await mkdir(join(repo, "docs"), { recursive: true });
  await gitExec(["init", "-q", repo]);
  await gitExec(["-C", repo, "remote", "add", "origin", "git@github.com:vet-org/pet-clinic.git"]);
  await writeFile(join(repo, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
  await writeFile(join(repo, "docs", "openapi.yaml"), "openapi: 3.0.3\n");
  await writeFile(
    join(repo, "compose.yaml"),
    "services:\n  web:\n    build: .\n    ports: ['8080:80']\n  db:\n    image: postgres\n    expose: ['5432']\n  worker:\n    image: x\n",
  );
  return repo;
};

const run = async (cwd: string, args: string[], answers?: string[]) => {
  let out = "";
  let err = "";
  let exitCode = 0;
  const queue = [...(answers ?? [])];
  await createProgram("1.0.0", {
    write: (t) => (out += t),
    writeError: (t) => (err += t),
    cwd,
    nodeVersion: "v22.22.0",
    setExitCode: (c) => (exitCode = c),
    ...(answers ? { ask: () => Promise.resolve(queue.shift() ?? "") } : {}),
    ports: {
      env: { QAJITSU_HOME: join(dirname(cwd), ".qajitsu-test") },
      home: dirname(cwd),
      now: () => new Date("2026-10-06T09:00:00Z"),
      random: () => 0,
      fetch: globalThis.fetch,
      gitExec: () => Promise.resolve({ stdout: "", stderr: "" }),
    },
  })
    .exitOverride()
    .parseAsync(["node", "qj", ...args]);
  return { out, err, exitCode };
};

describe("qajitsu init (REQ-GEN-03/AC3)", () => {
  it("REQ-GEN-03/AC3 + REQ-PRJ-02/AC2+AC3+AC5: onboards an unrelated project interactively, detecting host, compose, OpenAPI and test types", async () => {
    const repo = await otherProject();
    const r = await run(
      repo,
      ["init", "pet-clinic"],
      ["https://vets.atlassian.net", "vet", "http://localhost:8080"],
    );
    expect(r.err).toBe("");
    // REQ-PRJ-02/AC3: registered, but not ready until the Jira and GitHub tokens exist.
    expect(r.exitCode).toBe(2);
    expect(r.out).toContain("Project pet-clinic registered");
    expect(r.out).toContain("ticket prefixes: VET");
    expect(r.out).toMatch(/NOT READY:\n\s+✘ .*JIRA_TOKEN/);
    expect(r.out).toContain(
      "Detected: github repository vet-org/pet-clinic; tests: api, web; compose.yaml with 3 service(s); OpenAPI docs/openapi.yaml",
    );
    const raw = parse(await readFile(join(repo, ".qa", "qa.project.yaml"), "utf8")) as unknown;
    const config = parseProjectConfig(raw);
    expect(config).toMatchObject({
      project: "pet-clinic",
      jira: {
        type: "cloud",
        base_url: "https://vets.atlassian.net",
        project_key: "VET",
        token: "secret://env/JIRA_TOKEN",
      },
      code_hosts: { github: { type: "github", token: "secret://env/GITHUB_TOKEN" } },
      repos: { "pet-clinic": { host: "github", path: "vet-org/pet-clinic", openapi: "docs/openapi.yaml" } },
      environments: { default: "local", allowlist: ["http://localhost:8080"] },
      services: { web: { kind: "compose", port: 80 }, db: { kind: "compose", port: 5432 } },
      build: { repo: "pet-clinic", compose_file: "compose.yaml", base_service: "web" },
      test_types: ["api", "web"],
    });
    expect(await readFile(join(repo, ".qa", "envs", "local.yaml"), "utf8")).toContain(
      "base_url: http://localhost:8080",
    );
    // The generated project is the active one: doctor finds it.
    expect((await run(repo, ["doctor"])).out).toContain("✔ project config");
    // REQ-PRJ-02/AC5: re-running init changes nothing without --force.
    const again = await run(repo, ["init", "pet-clinic", "--yes"]);
    expect(again.out).toContain("already exists");
    expect(again.exitCode).toBe(0);
  });

  it("REQ-GEN-03/AC3: hosts from remotes; local repositories without a remote; mobile projects", async () => {
    expect(codeHostFromRemote("https://github.com/a/b.git", "/x/y")).toEqual({ type: "github", path: "a/b" });
    expect(codeHostFromRemote("git@gitlab.example.com:group/sub/app.git", "/x/y")).toEqual({
      type: "gitlab",
      path: "group/sub/app",
      baseUrl: "https://gitlab.example.com",
    });
    expect(codeHostFromRemote("https://gitlab.com/g/a", "/x/y")).toEqual({ type: "gitlab", path: "g/a" });
    expect(codeHostFromRemote(undefined, "/home/u/git/org/app")).toEqual({
      type: "local",
      root: "/home/u/git",
      path: "org/app",
    });
    expect(codeHostFromRemote("https://bitbucket.org/a/b.git", "/home/u/org/app")).toMatchObject({
      type: "local",
    });
    const home = await mkdtemp(join(tmpdir(), "qj-init-"));
    dirs.push(home);
    const app = join(home, "org", "mobile-app");
    await mkdir(join(app, "android"), { recursive: true });
    const d = await detectProject(app);
    expect(d).toMatchObject({
      name: "mobile-app",
      testTypes: ["api", "mobile"],
      codeHost: { type: "local", path: "org/mobile-app" },
    });
    expect(d.composeFile).toBeUndefined();
    const r = await run(app, ["init", "mobile-app", "--yes", "--env-url", "http://127.0.0.1:9000"]);
    expect(r.out).toContain("Project mobile-app registered");
    expect(parse(await readFile(join(app, ".qa", "qa.project.yaml"), "utf8"))).toMatchObject({
      code_hosts: { local: { type: "local", root: home } },
      test_types: ["api", "mobile"],
    });
    const fresh = join(home, "org", "other-app");
    await mkdir(fresh, { recursive: true });
    expect((await run(fresh, ["init", "other-app", "--yes", "--env-url", "not a url"])).exitCode).toBe(3);
  });

  it("REQ-PRJ-02/AC1+AC2+AC4+AC6 + REQ-PRJ-03/AC1+AC2+AC4+AC5: init links an existing .qa/, use switches, projects lists; tickets pick their project", async () => {
    const root = await mkdtemp(join(tmpdir(), "qj-projects-"));
    dirs.push(root);
    const link = async (name: string, key: string) => {
      const dir = join(root, name);
      await mkdir(join(dir, ".qa"), { recursive: true });
      await writeFile(
        join(dir, ".qa", "qa.project.yaml"),
        `project: ${name}\njira: { type: file, tickets_dir: t, project_key: ${key} }\n`,
      );
      return dir;
    };
    const bank = await link("bank", "BANK");
    const shop = await link("shop", "SHOP");
    const linked = await run(bank, ["init", "bank", "--yes"]);
    expect(linked.exitCode).toBe(0);
    expect(linked.out).toContain("active project: yes");
    expect(await readdir(join(root, ".qajitsu-test", "projects", "bank"))).toEqual(
      expect.arrayContaining(["runs", "cache", "knowledge", "exports", "logs", "project.yaml"]),
    );
    // REQ-PRJ-02/AC4: --no-use keeps the active project.
    const shopInit = await run(shop, [
      "init",
      "shop",
      "--yes",
      "--no-use",
      "--jira-prefix",
      "SHOP",
      "--jira-prefix",
      "store",
    ]);
    expect(shopInit.out).toContain("active project: no");
    expect(shopInit.out).toContain("ticket prefixes: SHOP, STORE");
    // REQ-PRJ-02/AC6: the knowledge base starts empty; nothing is indexed by init.
    expect(await readdir(join(root, ".qajitsu-test", "projects", "shop", "knowledge"))).toEqual([]);
    expect((await run(bank, ["projects", "current"])).out).toBe("bank\n");
    const list = (await run(bank, ["projects", "list"])).out;
    expect(list).toMatch(/^\* bank {2}ready {2}prefixes BANK/m);
    expect(list).toMatch(/^ {2}shop {2}ready {2}prefixes SHOP,STORE/m);
    const used = await run(bank, ["use", "shop"]);
    expect(used.out).toContain("Active project: shop");
    expect(used.out).toContain("0 ticket(s), 0 run(s)");
    expect((await run(bank, ["projects", "current"])).out).toBe("shop\n");
    expect((await run(bank, ["use", "nope"])).err).toContain("PROJECT_NOT_FOUND");
    // REQ-PRJ-03/AC2+AC4: the ticket prefix wins over the active project; --project wins over both.
    expect((await run(bank, ["logs", "BANK-1"])).out.split("\n")[0]).toBe(
      "Project: bank (ticket prefix BANK)",
    );
    expect((await run(bank, ["--project", "shop", "logs", "BANK-1"])).out.split("\n")[0]).toBe(
      "Project: shop (flag)",
    );
  });
});
