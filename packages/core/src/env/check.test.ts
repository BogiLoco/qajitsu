import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseProjectConfig } from "../config/project-config.js";
import { checkBuildConfig } from "./check.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const base = {
  project: "demo",
  jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
  code_hosts: { local: { type: "local", root: "~/git" } },
  repos: { shop: { host: "local", path: "demo-org/demo-shop" } },
};

describe("env check (REQ-CFG-04, REQ-CFG-01/AC1)", () => {
  it("REQ-CFG-04/AC1 + REQ-CFG-01/AC1: lists every missing or invalid variable and committed secrets without starting anything", async () => {
    const qaDir = await mkdtemp(join(tmpdir(), "qj-check-"));
    dirs.push(qaDir);
    const config = parseProjectConfig({
      ...base,
      services: {
        api: {
          kind: "process",
          command: ["node", "server.mjs", "--port", "{{port}}", "{{svc.nope.port}}"],
          env: {
            PASSWORD: { secret: "secret://env/MISSING" },
            OK: { secret: "secret://env/PRESENT" },
            API_TOKEN: "abc123-committed",
            DB: { template: "postgres://{{svc.db.host}}:{{svc.db.port}}/{{bogus}}" },
          },
        },
        db: { kind: "compose", port: 5432, env: { X: { template: "{{port}}" } } },
        pay: { kind: "stub", engine: "wiremock", mappings: "stubs/pay" },
      },
      build: {
        repo: "shop",
        base_service: "api",
        compose_file: "missing.yml",
        seed: "hooks/seed.mjs",
        profile: "local",
      },
    });
    const problems = await checkBuildConfig({
      config,
      qaDir,
      worktree: qaDir,
      secretExists: (r) => Promise.resolve(r.endsWith("PRESENT")),
    });
    expect(problems.map((p) => p.where)).toEqual([
      "build.compose_file",
      "build.seed",
      "build.profile",
      "api.PASSWORD",
      "api.API_TOKEN",
      "api.command",
      "api.DB",
      "db.X",
      "pay.mappings",
    ]);
  });

  it("REQ-CFG-04/AC1: a complete configuration has no problems", async () => {
    const qaDir = await mkdtemp(join(tmpdir(), "qj-check-"));
    dirs.push(qaDir);
    await mkdir(join(qaDir, "stubs", "pay"), { recursive: true });
    await writeFile(join(qaDir, "compose.yml"), "services: {}\n");
    const config = parseProjectConfig({
      ...base,
      services: {
        api: {
          kind: "process",
          command: ["node", "s.mjs", "{{port}}"],
          env: { DB: { template: "{{svc.db.url}}" } },
        },
        db: { kind: "compose", port: 5432 },
        pay: { kind: "stub", engine: "mockoon", mappings: "stubs/pay" },
      },
      build: { repo: "shop", base_service: "api", compose_file: "compose.yml" },
    });
    expect(
      await checkBuildConfig({ config, qaDir, worktree: qaDir, secretExists: () => Promise.resolve(true) }),
    ).toEqual([]);
    expect(
      await checkBuildConfig({
        config: parseProjectConfig(base),
        qaDir,
        secretExists: () => Promise.resolve(true),
      }),
    ).toEqual([{ where: "build", problem: "not configured in .qa/qa.project.yaml" }]);
    const missingCompose = await checkBuildConfig({
      config: parseProjectConfig({
        ...base,
        services: config.services,
        build: { ...config.build, compose_file: "nope.yml" },
      }),
      qaDir,
      worktree: qaDir,
      secretExists: () => Promise.resolve(true),
    });
    expect(missingCompose.map((p) => p.where)).toEqual(["build.compose_file"]);
  });
});
