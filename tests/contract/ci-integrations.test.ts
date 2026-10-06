// The ready-made CI integrations (REQ-CI-01) and the shared step script (REQ-CI-03): structure checks and a
// dry run of the script with a fake `qajitsu`, so the flow and the approval rules are tested without a CI.
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const yaml = async <T>(path: string): Promise<T> => parse(await readFile(join(root, path), "utf8")) as T;

/** Runs ci/qajitsu-ci.sh with a fake qajitsu that logs its arguments. */
const script = async (args: string[], env: Record<string, string>, failRun = 0) => {
  const dir = await mkdtemp(join(tmpdir(), "qj-ci-"));
  const log = join(dir, "calls");
  const fake = join(dir, "qj");
  await writeFile(
    fake,
    `#!/bin/sh\necho "$*" >> "${log}"\nif [ "$1" = run ]; then exit ${String(failRun)}; fi\n`,
  );
  await chmod(fake, 0o755);
  const code = await new Promise<number>((resolve) => {
    execFile(
      "bash",
      [join(root, "ci/qajitsu-ci.sh"), ...args],
      { env: { PATH: process.env["PATH"] ?? "", QJ: fake, ...env } },
      (e) => {
        resolve(e ? ((e as { code?: number }).code ?? 1) : 0);
      },
    );
  });
  const calls = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  await rm(dir, { recursive: true, force: true });
  return { code, calls };
};

interface Workflow {
  readonly on: Record<string, unknown>;
  readonly jobs: Record<string, { readonly environment?: string; readonly steps: unknown[] }>;
}

describe("CI integrations (REQ-CI-01, REQ-CI-03, REQ-CI-04)", () => {
  it("REQ-CI-03/AC1: plan fetches, plans, posts to Jira and the PR; /qa revise makes a new version", async () => {
    expect(
      (
        await script(["plan", "DEMO-1"], {
          QA_CHANGE: "https://github.com/o/r/pull/1",
          QA_REFS: "--ref shop=main",
        })
      ).calls,
    ).toEqual([
      // ADR-0006: the checked-out .qa/ becomes the project of the job.
      "init ci --qa-dir .qa --yes --force",
      "fetch DEMO-1 --ref shop=main",
      "plan DEMO-1",
      "ci publish-plan DEMO-1",
      "ci comment DEMO-1 --change https://github.com/o/r/pull/1",
    ]);
    expect((await script(["plan", "DEMO-1"], { QA_REVISE: "add expired codes" })).calls).toEqual([
      "init ci --qa-dir .qa --yes --force",
      "plan DEMO-1 --revise add expired codes",
      "ci publish-plan DEMO-1",
    ]);
  });

  it("REQ-PLAN-07/AC4 + REQ-CI-03/AC3+AC4: run needs a named approver or reuses an approved plan; exit code is the run's", async () => {
    const refused = await script(["run", "DEMO-1"], {});
    expect(refused.code).not.toBe(0);
    expect(refused.calls).toEqual(["init ci --qa-dir .qa --yes --force"]);
    const approved = await script(["run", "DEMO-1"], { QA_APPROVER: "github:alice", QA_ENV: "staging" }, 1);
    expect(approved.code).toBe(1);
    expect(approved.calls).toEqual([
      "init ci --qa-dir .qa --yes --force",
      "approve DEMO-1 --approver github:alice --confirm-open-questions",
      "run DEMO-1 --env staging",
      "export DEMO-1 --out qa-artifacts",
    ]);
    const pinned = await script(["run", "DEMO-1"], { QA_APPROVER: "github:alice", QA_VERSION: "2" });
    expect(pinned.calls.slice(1, 3)).toEqual([
      "approve DEMO-1 --approver github:alice --confirm-open-questions --version 2",
      "run DEMO-1",
    ]);
    const reused = await script(["run", "DEMO-1"], { QA_REUSE: "true", QA_BUILD: "true" });
    expect(reused.calls).toEqual([
      "init ci --qa-dir .qa --yes --force",
      "fetch DEMO-1",
      "approve DEMO-1 --reuse-from latest --approver ci",
      "run DEMO-1 --build",
      "export DEMO-1 --out qa-artifacts",
    ]);
  });

  it("stage-10 review: run folders tracked by git are refused (a PR cannot plant an approved run)", async () => {
    const repo = await mkdtemp(join(tmpdir(), "qj-ci-repo-"));
    try {
      await new Promise((r) => execFile("git", ["init", "-q", repo], r));
      await writeFile(join(repo, "planted"), "x");
      await new Promise((r) => execFile("git", ["-C", repo, "add", "planted"], r));
      const fake = join(repo, "qj.sh");
      await writeFile(fake, "#!/bin/sh\necho called\n");
      await chmod(fake, 0o755);
      const code = await new Promise<number>((resolve) => {
        execFile(
          "bash",
          [join(root, "ci/qajitsu-ci.sh"), "plan", "DEMO-1"],
          { cwd: repo, env: { PATH: process.env["PATH"] ?? "", QJ: fake, QAJITSU_WORKSPACE: "planted" } },
          (e) => {
            resolve(e ? ((e as { code?: number }).code ?? 1) : 0);
          },
        );
      });
      expect(code).toBe(3);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("REQ-CI-01/AC1: the GitHub Action offers detect, plan and run; the example workflow gates run on a protected environment", async () => {
    const action = await yaml<{ runs: { using: string }; inputs: Record<string, unknown> }>(
      "ci/github/action.yml",
    );
    expect(action.runs.using).toBe("composite");
    expect(Object.keys(action.inputs)).toEqual(
      expect.arrayContaining(["command", "ticket", "change", "approver", "reuse", "revise"]),
    );
    const wf = await yaml<Workflow>("ci/github/qajitsu.workflow.yml");
    expect(Object.keys(wf.on)).toEqual([
      "pull_request",
      "issue_comment",
      "workflow_dispatch",
      "repository_dispatch",
    ]);
    expect(wf.jobs["run"]?.environment).toContain("qa-approval");
    expect(JSON.stringify(wf.jobs["run"])).toContain("upload-artifact");
    expect(JSON.stringify(wf.jobs["plan"]?.steps)).toContain('command":"plan');
    // Inputs reach shells only through env; caches are per PR; the run job checks out the PR head.
    const actionText = await readFile(join(root, "ci/github/action.yml"), "utf8");
    expect(actionText).not.toMatch(/run:.*\$\{\{ inputs\./);
    const wfText = await readFile(join(root, "ci/github/qajitsu.workflow.yml"), "utf8");
    expect(wfText).toContain("pull_request.number || github.event.issue.number");
    expect(wfText).toContain("head.sha");
    expect(wfText).toContain("/approvals");
    expect(wfText).not.toContain("pull_request_target");
  });

  it("REQ-CI-01/AC2+AC3 + REQ-CI-04/AC2+AC3: GitLab .qa-plan/.qa-run with a manual approval job and JUnit; Docker image and Jenkins", async () => {
    const gl = await yaml<Record<string, { script?: string[] }>>("ci/gitlab/qajitsu.gitlab-ci.yml");
    expect(gl[".qa-run"]).toMatchObject({
      when: "manual",
      artifacts: { reports: { junit: "qa-artifacts/junit.xml" } },
    });
    expect(gl[".qa-plan"]?.script).toEqual(['qajitsu-ci.sh plan "$QA_TICKET"']);
    expect(JSON.stringify(gl[".qa-base"])).toContain("--format env");
    const docker = await readFile(join(root, "ci/docker/Dockerfile"), "utf8");
    expect(docker).toMatch(/FROM node:22/);
    expect(docker).toContain("git");
    expect(docker).toContain("playwright-core install --with-deps chromium");
    const jenkins = await readFile(join(root, "ci/jenkins/Jenkinsfile"), "utf8");
    expect(jenkins).toContain("input(message");
    expect(jenkins).toContain("junit");
  });
});
