import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildProject } from "../../../tests/support/cli-build.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("doctor project checks (REQ-GEN-03/AC2)", () => {
  it("REQ-GEN-03/AC2: secrets by reference only, Jira and code host access online, mobile tooling", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    const offline = await p.run(["doctor"]);
    expect(offline.out).toContain("✔ secrets:");
    expect(offline.out).not.toContain("✔ jira");
    const online = await p.run(["doctor", "--online"]);
    expect(online.out).toMatch(/✔ jira: ticket files in .+tickets/);
    expect(online.out).toMatch(/✔ code host local: repositories under/);
    expect(online.exitCode).toBe(0);
    // A secret that cannot be resolved is named by its reference, never by a value.
    const yaml = join(p.project, ".qa", "qa.project.yaml");
    await writeFile(
      yaml,
      (await readFile(yaml, "utf8")).replace(
        "secret://env/DEMO_USER_PASSWORD",
        "secret://env/NOT_SET_ANYWHERE",
      ) +
        "\nmobile:\n  appium: { bin: ./missing-appium }\n  android: { app: { source: path, repo: shop, path: a.apk }, app_id: a.b, sdk_root: /nonexistent/sdk }\n",
    );
    const broken = await p.run(["doctor"]);
    expect(broken.exitCode).toBe(3);
    expect(broken.out).toContain("✘ secrets: cannot resolve secret://env/NOT_SET_ANYWHERE");
    expect(broken.out).toContain("✘ android: missing /nonexistent/sdk/platform-tools/adb");
    expect(broken.out).toMatch(/✘ appium: .*missing-appium not found/);
  }, 120_000);
});

describe("versions in doctor (REQ-GEN-03/AC4+AC5)", () => {
  it("REQ-GEN-03/AC4+AC5: tool versions and the application's mirror, default branch, latest run and remote", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    const fresh = await p.run(["doctor"]);
    expect(fresh.out).toContain("Versions:");
    expect(fresh.out).toMatch(/✔ node +v22\.22\.0/);
    expect(fresh.out).toMatch(/✔ git +\d+\.\d+/);
    expect(fresh.out).toContain("Application under test:");
    expect(fresh.out).toMatch(/✔ shop +no mirror yet \(qj fetch downloads it\) · no run yet/);

    const dir = await p.prepare();
    await p.run(["run", "DEMO-1", "--build"]);
    const runId = dir.split("/").at(-1) ?? "";
    const record = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as {
      repos: { shop: { sha: string } };
      data: { versions: Record<string, string> };
    };
    const sha = record.repos.shop.sha;
    const after = await p.run(["doctor", "--online"]);
    expect(after.out).toMatch(
      new RegExp(
        `✔ shop +mirror updated [\\d-]+ [\\d:]+ · main [0-9a-f]{12} · last run ${sha.slice(0, 12)} \\(DEMO-1 ${runId}\\)`,
      ),
    );
    expect(after.out).toMatch(/✔ shop remote +main [0-9a-f]{12}, the mirror is up to date/);
    expect(after.exitCode).toBe(0);

    // REQ-OBS-10/AC1: the run recorded what it was tested with.
    expect(record.data.versions).toMatchObject({ node: process.version, "model default": "mock/scripted" });
    expect(record.data.versions["qajitsu"]).toMatch(/^\d+\.\d+\.\d+/);
    expect(Object.keys(record.data.versions)).toEqual(expect.arrayContaining(["os", "git"]));
    // The app runs as a managed process, not in Docker: Docker is not recorded for this project.
    expect(record.data.versions["docker"]).toBeUndefined();

    // A mirror that cannot be read is an error with the fix.
    const mirror = join(p.home, "cache", "local", "demo-org", "demo-shop.git");
    await rm(join(mirror, "refs"), { recursive: true, force: true });
    await rm(join(mirror, "packed-refs"), { force: true });
    const broken = await p.run(["doctor"]);
    expect(broken.exitCode).toBe(3);
    expect(broken.out).toMatch(
      /✘ shop: the mirror .+demo-shop\.git cannot be read; fix: qj clean --project, then qj fetch downloads it again/,
    );
  }, 240_000);

  it("REQ-GEN-03/AC5: deployed versions per environment online, and where the mobile app comes from", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    const env = join(p.project, ".qa", "envs", "local.yaml");
    await writeFile(env, `${await readFile(env, "utf8")}version_path: /version\n`);
    const yaml = join(p.project, ".qa", "qa.project.yaml");
    await writeFile(
      yaml,
      `${await readFile(yaml, "utf8")}\nmobile:\n  android: { app: { source: build, repo: shop, command: [node, android/build.mjs], output: android/app.apk }, app_id: a.b }\n`,
    );
    const r = await p.run(["doctor", "--online"]);
    expect(r.out).toMatch(
      /✔ env local +deployed version unknown \(http:\/\/localhost:3000\/version did not answer with a commit\)/,
    );
    expect(r.out).toMatch(
      /✔ android app +built in the shop worktree of each run: node android\/build\.mjs → android\/app\.apk/,
    );
  }, 120_000);
});
