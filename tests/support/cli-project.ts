import { copyFile, cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitExec } from "@qajitsu/core";

export const gitExec = createGitExec({ PATH: process.env["PATH"] ?? "", HOME: tmpdir() });

/**
 * A throwaway project for CLI tests: `.qa/` config (file tickets, local git host), the DEMO-1 ticket
 * from the demo-shop and a local repository with a `feature/DEMO-1-...` branch. No network.
 */
export async function createCliProject(
  extraYaml: string[] = [],
  options: { readonly withShopApi?: boolean } = {},
): Promise<{ home: string; project: string; sha: string }> {
  const home = await mkdtemp(join(tmpdir(), "qj-home-"));
  const project = join(home, "project");
  const repo = join(home, "git", "demo-org", "demo-shop");
  const g = (...args: string[]) =>
    gitExec(["-C", repo, "-c", "user.name=qa", "-c", "user.email=qa@example.com", ...args]);
  await gitExec(["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "cart.ts"), "export const v = 1;\n");
  // The demo-shop API in the repository, so `--build` can start it from the worktree (stage 6).
  if (options.withShopApi === true) {
    await cp(new URL("../../examples/demo-shop/api", import.meta.url), join(repo, "api"), {
      recursive: true,
    });
    await copyFile(
      new URL("../../examples/demo-shop/docker-compose.yml", import.meta.url),
      join(repo, "docker-compose.yml"),
    );
  }
  await g("add", ".");
  await g("commit", "-qm", "init");
  await g("checkout", "-qb", "feature/DEMO-1-cart-discounts");
  await writeFile(join(repo, "cart.ts"), "export const v = 2;\n");
  await g("commit", "-qam", "DEMO-1 discounts");
  const sha = (await g("rev-parse", "HEAD")).stdout.trim();
  await g("checkout", "-q", "main");
  await mkdir(join(project, ".qa"), { recursive: true });
  await mkdir(join(project, "tickets"));
  await copyFile(
    new URL("../../examples/demo-shop/tickets/DEMO-1.json", import.meta.url),
    join(project, "tickets", "DEMO-1.json"),
  );
  await writeFile(
    join(project, ".qa", "qa.project.yaml"),
    [
      "project: demo",
      "jira: { type: file, tickets_dir: ../tickets, project_key: DEMO }",
      "workspace: { root: ~/runs, git_cache: ~/cache }",
      "code_hosts: { local: { type: local, root: ~/git } }",
      "repos: { shop: { host: local, path: demo-org/demo-shop } }",
      "environments: { allowlist: ['http://localhost:3000'] }",
      // The auditor makes model calls; tests that cover it switch it on (stage 7).
      ...(extraYaml.some((l) => /^verification:/m.test(l)) ? [] : ["verification: { auditor: off }"]),
      ...extraYaml,
    ].join("\n"),
  );
  return { home, project, sha };
}
