import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunIndex, type TicketKey } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildProject } from "../../../../tests/support/cli-build.js";
import { detectTrigger, parseQaCommand, pipelineUrl } from "./ci.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const opts = { projectKey: "DEMO", label: "qa-agent" };
const gh = (name: string) => ({ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: name, GITHUB_REPOSITORY: "o/r" });
const pr = (labels: string[], ref = "feature/DEMO-1-cart", title = "Cart") => ({
  pull_request: {
    number: 12,
    title,
    html_url: "https://github.com/o/r/pull/12",
    labels: labels.map((name) => ({ name })),
    head: { ref, sha: "a".repeat(40) },
  },
});

describe("CI triggers (REQ-CI-02, REQ-PLAN-07)", () => {
  it("REQ-CI-02/AC1: a PR with the label and a ticket key in the branch or title runs; others do not", () => {
    expect(detectTrigger(gh("pull_request"), pr(["qa-agent"]), opts)).toMatchObject({
      trigger: "label",
      run: true,
      ticket: "DEMO-1",
      mode: "full",
      change: { url: "https://github.com/o/r/pull/12", sha: "a".repeat(40) },
    });
    expect(detectTrigger(gh("pull_request"), pr(["qa-agent"], "main", "DEMO-7 fix"), opts).ticket).toBe(
      "DEMO-7",
    );
    expect(detectTrigger(gh("pull_request"), pr(["bug"]), opts)).toMatchObject({
      run: false,
      reason: "pull request has no 'qa-agent' label",
    });
    expect(detectTrigger(gh("pull_request"), pr(["qa-agent"], "main", "no key"), opts).run).toBe(false);
    expect(detectTrigger(gh("pull_request"), { nonsense: true }, opts).reason).toBe(
      "unexpected pull_request payload",
    );
    expect(detectTrigger(gh("push"), {}, opts).run).toBe(false);
  });

  it("REQ-PLAN-07/AC2 + REQ-CI-03/AC2+AC3: /qa approve and /qa revise only from people with write access", () => {
    const comment = (body: string, association: string) => ({
      issue: { title: "DEMO-1 cart", pull_request: { html_url: "https://github.com/o/r/pull/12" } },
      comment: { body, user: { login: "alice" }, author_association: association },
    });
    expect(detectTrigger(gh("issue_comment"), comment("/qa approve v2", "MEMBER"), opts)).toMatchObject({
      trigger: "comment",
      run: true,
      mode: "run",
      command: { name: "approve", user: "alice", allowed: true, version: 2 },
    });
    // Approval names the version the reviewer read.
    expect(detectTrigger(gh("issue_comment"), comment("/qa approve", "MEMBER"), opts).reason).toBe(
      "say which plan version to approve: /qa approve v<N>",
    );
    // QAJitsu's own comment (it quotes the plan) and bots never trigger.
    expect(
      detectTrigger(gh("issue_comment"), comment("<!-- qajitsu:DEMO-1 -->\n/qa approve v1", "MEMBER"), opts)
        .run,
    ).toBe(false);
    expect(
      detectTrigger(
        gh("issue_comment"),
        {
          ...comment("/qa approve v1", "MEMBER"),
          comment: {
            body: "/qa approve v1",
            user: { login: "x[bot]", type: "Bot" },
            author_association: "MEMBER",
          },
        },
        opts,
      ).run,
    ).toBe(false);
    // pull_request_target (secrets for fork PRs) is not a trigger.
    expect(detectTrigger(gh("pull_request_target"), pr(["qa-agent"]), opts).run).toBe(false);
    // A dispatch cannot smuggle extra outputs through the environment name.
    expect(
      detectTrigger(
        gh("repository_dispatch"),
        { client_payload: { ticket: "DEMO-4", env: "x\nticket=evil" } },
        opts,
      ).env,
    ).toBeUndefined();
    expect(
      detectTrigger(
        gh("issue_comment"),
        comment("Looks fine.\n/qa revise add a test for expired codes", "OWNER"),
        opts,
      ),
    ).toMatchObject({
      mode: "plan",
      command: { name: "revise", text: "add a test for expired codes" },
    });
    expect(detectTrigger(gh("issue_comment"), comment("/qa approve v1", "NONE"), opts)).toMatchObject({
      run: false,
      reason: "alice may not approve plans (needs write access)",
    });
    expect(
      detectTrigger(
        gh("issue_comment"),
        { ...comment("/qa approve", "MEMBER"), issue: { title: "DEMO-1" } },
        opts,
      ).run,
    ).toBe(false);
    expect(detectTrigger(gh("issue_comment"), comment("nice work", "MEMBER"), opts).run).toBe(false);
    expect(parseQaCommand("/qa approved")).toBeUndefined();
  });

  it("REQ-CI-02/AC2+AC3: manual runs and Jira dispatches carry ticket, environment and mode", () => {
    expect(
      detectTrigger(
        gh("workflow_dispatch"),
        { inputs: { ticket: "DEMO-3", env: "staging", mode: "run" } },
        opts,
      ),
    ).toMatchObject({
      trigger: "manual",
      ticket: "DEMO-3",
      env: "staging",
      mode: "run",
    });
    expect(
      detectTrigger(
        gh("repository_dispatch"),
        { client_payload: { ticket: "DEMO-4", status: "Ready for QA" } },
        opts,
      ),
    ).toMatchObject({
      trigger: "jira",
      ticket: "DEMO-4",
      mode: "plan",
      reason: "Jira: Ready for QA",
    });
    expect(detectTrigger(gh("workflow_dispatch"), { inputs: { ticket: "bad key" } }, opts).run).toBe(false);
    const gl = {
      GITLAB_CI: "true",
      CI_PIPELINE_SOURCE: "merge_request_event",
      CI_MERGE_REQUEST_LABELS: "backend,qa-agent",
      CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "DEMO-2-orders",
      CI_MERGE_REQUEST_TITLE: "Orders",
      CI_MERGE_REQUEST_PROJECT_URL: "https://gitlab.example.com/shop/api",
      CI_MERGE_REQUEST_IID: "7",
      CI_COMMIT_SHA: "b".repeat(40),
    };
    expect(detectTrigger(gl, undefined, opts)).toMatchObject({
      trigger: "label",
      ticket: "DEMO-2",
      change: { url: "https://gitlab.example.com/shop/api/-/merge_requests/7" },
    });
    expect(detectTrigger({ ...gl, CI_MERGE_REQUEST_LABELS: "backend" }, undefined, opts).run).toBe(false);
    expect(
      detectTrigger(
        { GITLAB_CI: "true", CI_PIPELINE_SOURCE: "trigger", QA_TICKET: "DEMO-5", QA_TRIGGER: "jira" },
        undefined,
        opts,
      ),
    ).toMatchObject({ trigger: "jira", mode: "plan" });
    expect(
      detectTrigger(
        { GITLAB_CI: "true", CI_PIPELINE_SOURCE: "web", QA_TICKET: "DEMO-5", QA_ENV: "staging" },
        undefined,
        opts,
      ),
    ).toMatchObject({ trigger: "manual", env: "staging", mode: "full" });
    expect(detectTrigger({ GITLAB_CI: "true", CI_PIPELINE_SOURCE: "push" }, undefined, opts).run).toBe(false);
    expect(detectTrigger({ QA_TICKET: "DEMO-1", QA_MODE: "plan" }, undefined, opts)).toMatchObject({
      trigger: "manual",
      mode: "plan",
    });
    expect(detectTrigger({}, undefined, opts).run).toBe(false);
    expect(pipelineUrl({ GITHUB_RUN_ID: "5", GITHUB_REPOSITORY: "o/r" })).toBe(
      "https://github.com/o/r/actions/runs/5",
    );
    expect(pipelineUrl({ CI_PIPELINE_URL: "https://gitlab/p/1" })).toBe("https://gitlab/p/1");
  });
});

describe("qajitsu ci and pipeline outputs (REQ-CI-03, REQ-CI-04)", () => {
  it("REQ-CI-02 + REQ-CI-05/AC2: ci detect writes GitHub outputs and skips changes outside --paths", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    const dir = await mkdtemp(join(tmpdir(), "qj-gh-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "event.json"), JSON.stringify(pr(["qa-agent"])));
    const env = {
      ...gh("pull_request"),
      GITHUB_EVENT_PATH: join(dir, "event.json"),
      GITHUB_OUTPUT: join(dir, "out"),
    };
    const r = await p.run(["ci", "detect"], undefined, { env });
    expect(r.exitCode).toBe(0);
    expect(await readFile(join(dir, "out"), "utf8")).toContain("run=true\nticket=DEMO-1\nmode=full");
    // Shell-safe export lines for GitLab: quotes in values cannot break out.
    const shell = await p.run(["ci", "detect", "--format", "env"], undefined, {
      env: { QA_TICKET: "DEMO-1", QA_ENV: "staging" },
    });
    expect(shell.out).toBe(
      "export QA_RUN='true'\nexport QA_TICKET='DEMO-1'\nexport QA_CHANGE=''\nexport QA_MODE='full'\nexport QA_ENV='staging'\n",
    );
    // Path filter: the demo repository has no change under docs/, so nothing runs.
    const filtered = await p.run(["ci", "detect", "--paths", "docs/**"], undefined, {
      env: { ...env, GITHUB_BASE_REF: "main", GITHUB_OUTPUT: join(dir, "out2") },
    });
    expect(filtered.out).toContain('"run": false');
  });

  it("REQ-CI-04/AC2+AC3 + REQ-CI-03/AC1+AC4: export bundles artifacts; the plan goes to Jira; approval is explicit or reused", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    await p.run(["fetch", "DEMO-1"]);
    const draft = await readFile(
      new URL("../../../../fixtures/plans/demo-1-draft.json", import.meta.url),
      "utf8",
    );
    const analysis = JSON.stringify({
      summary: "Cart API.",
      change_type: ["api"],
      endpoints: [{ method: "GET", path: "/cart", source: [{ kind: "ac", id: "AC1" }] }],
      confidence: "high",
    });
    await p.run(["plan", "DEMO-1"], [{ text: analysis }, { text: draft }]);
    const posted = await p.run(["ci", "publish-plan", "DEMO-1"]);
    expect(posted.out).toContain("Posted the plan on DEMO-1");
    expect((await p.run(["ci", "publish-plan", "DEMO-1"])).out).toContain("Updated the plan on DEMO-1");
    expect((await p.run(["approve", "DEMO-1", "--approver", "github:alice"])).exitCode).toBe(0);
    const root = join(p.home, "runs", "DEMO-1");
    const first = (await readRunIndex(join(p.home, "runs"), "DEMO-1" as TicketKey)).latest ?? "";
    expect(JSON.parse(await readFile(join(root, first, "run.json"), "utf8"))).toMatchObject({
      data: { approval: { approver: "github:alice" } },
    });
    // New commits: a new run reuses the approved plan because the ticket is unchanged.
    await p.run(["fetch", "DEMO-1"]);
    const second = (await readRunIndex(join(p.home, "runs"), "DEMO-1" as TicketKey)).latest ?? "";
    expect(second).not.toBe(first);
    const reused = await p.run(["approve", "DEMO-1", "--reuse-from", "latest", "--approver", "ci"]);
    expect(reused.out).toContain(`approved in run ${first}`);
    expect(JSON.parse(await readFile(join(root, second, "run.json"), "utf8"))).toMatchObject({
      data: { approval: { approver: `ci (reusing github:alice, run ${first})` } },
    });
    // A changed ticket is refused: new plans are never approved automatically.
    await p.run(["fetch", "DEMO-1"]);
    const third = (await readRunIndex(join(p.home, "runs"), "DEMO-1" as TicketKey)).latest ?? "";
    const ticketFile = join(root, third, "ticket", "ticket.json");
    await writeFile(ticketFile, (await readFile(ticketFile, "utf8")).replace("discount", "rebate"));
    expect((await p.run(["approve", "DEMO-1", "--reuse-from", first])).err).toContain("TICKET_CHANGED");
    // Run the reused plan and export the pipeline artifacts.
    for (const id of ["TC-01", "TC-02"])
      await writeFile(
        join(root, second, "specs", `${id}.spec.ts`),
        await readFile(new URL(`../../../../fixtures/specs/demo-1/${id}.spec.ts`, import.meta.url)),
      );
    expect((await p.run(["run", "DEMO-1", "--run", second, "--build"])).exitCode).toBe(0);
    const out = join(p.project, "qa-artifacts");
    const exported = await p.run(["export", "DEMO-1", "--run", second, "--out", "qa-artifacts"]);
    expect(exported.exitCode).toBe(0);
    expect((await readdir(out)).sort()).toEqual(
      [
        "DEMO-1_" + second + "_evidence.zip",
        "gates.json",
        "junit.xml",
        "matrix.csv",
        "matrix.md",
        "report.html",
      ].sort(),
    );
    expect(await readFile(join(out, "junit.xml"), "utf8")).toContain('tests="2" failures="0"');
    expect((await p.run(["export", "DEMO-1", "--run", first, "--out", "x"])).err).toContain(
      "RUN_NOT_EXECUTED",
    );
    // A forged approval (run.json edited, nothing in the journal) is never reused.
    const forged = join(root, first, "run.json");
    await writeFile(
      forged,
      (await readFile(forged, "utf8")).replace('"approver": "github:alice"', '"approver": "github:mallory"'),
    );
    await p.run(["fetch", "DEMO-1"]);
    expect((await p.run(["approve", "DEMO-1", "--reuse-from", first])).err).toContain(
      "not backed by its journal",
    );
  }, 180_000);
});

describe("PR/MR comment content (REQ-CI-03/AC1, REQ-CI-04/AC4)", () => {
  it("REQ-CI-03/AC1 + REQ-CI-04/AC4 + REQ-PUB-05/AC4: a waiting plan asks for /qa approve; results show the matrix and map to a status", async () => {
    const { openSession } = await import("../session.js");
    const { ciSummary } = await import("./ci.js");
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    const ports = {
      env: { DEMO_USER_PASSWORD: "fictional-demo-password" },
      home: p.home,
      now: () => new Date(),
      random: Math.random,
      fetch: globalThis.fetch,
      gitExec: () => Promise.resolve({ stdout: "", stderr: "" }),
    };
    const env = { GITHUB_RUN_ID: "9", GITHUB_REPOSITORY: "o/r" };
    // prepare() approves; a run without results reports "approved, running".
    const before = await ciSummary(
      await openSession("DEMO-1", undefined, p.project, ports),
      () => new Date(),
      env,
    );
    expect(before).toMatchObject({ state: "pending", description: "plan approved, tests running" });
    expect(before.body).toContain("<!-- qajitsu:DEMO-1 -->");
    expect(before.body).toContain("<details><summary>Plan</summary>");
    expect(
      (await p.run(["run", "DEMO-1", "--build", "--set", "api.BUG_CART_TOTAL_ROUNDING=1"])).exitCode,
    ).toBe(1);
    const after = await ciSummary(
      await openSession("DEMO-1", undefined, p.project, ports),
      () => new Date(),
      env,
    );
    expect(after.state).toBe("failure");
    expect(after.description).toBe("1 FAILED, 1 PASSED");
    expect(after.body).toContain("| TC-01 |");
    expect(after.body).toContain("Evidence and report.html: https://github.com/o/r/actions/runs/9");
    expect(dir).toContain("DEMO-1");
    expect((await p.run(["ci", "comment", "DEMO-1", "--change", "https://example.com/x"])).err).toContain(
      "CI_CHANGE_UNKNOWN",
    );
  }, 120_000);
});
