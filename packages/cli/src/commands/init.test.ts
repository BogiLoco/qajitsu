import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  })
    .exitOverride()
    .parseAsync(["node", "qj", ...args]);
  return { out, err, exitCode };
};

describe("qajitsu init (REQ-GEN-03/AC3)", () => {
  it("REQ-GEN-03/AC3: onboards an unrelated project interactively, detecting host, compose, OpenAPI and test types", async () => {
    const repo = await otherProject();
    const r = await run(repo, ["init"], ["https://vets.atlassian.net", "vet", "http://localhost:8080"]);
    expect(r.err).toBe("");
    expect(r.exitCode).toBe(0);
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
    // The generated project loads: doctor finds it.
    expect((await run(repo, ["doctor"])).out).toContain("✔ project config");
    // Never overwrites without --force.
    expect((await run(repo, ["init", "--yes"])).err).toContain("INIT_EXISTS");
    expect((await run(repo, ["init", "--yes", "--force", "--project-key", "PC"])).exitCode).toBe(0);
    expect(parse(await readFile(join(repo, ".qa", "qa.project.yaml"), "utf8"))).toMatchObject({
      jira: { type: "file", project_key: "PC" },
    });
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
    const r = await run(app, ["init", "--yes", "--env-url", "http://127.0.0.1:9000"]);
    expect(r.exitCode).toBe(0);
    expect(parse(await readFile(join(app, ".qa", "qa.project.yaml"), "utf8"))).toMatchObject({
      code_hosts: { local: { type: "local", root: home } },
      test_types: ["api", "mobile"],
    });
    expect((await run(app, ["init", "--yes", "--force", "--env-url", "not a url"])).exitCode).toBe(3);
  });
});
