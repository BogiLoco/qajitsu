import { readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPlaywrightTransport, executeAttempt, type AttemptExecutor } from "@qajitsu/adapter-runner-api";
import { parseEventLines } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { createCliProject, gitExec } from "../../../../tests/support/cli-project.js";
import { scriptedModel, type Turn } from "../../../../tests/support/mock-model.js";
import { startShop } from "../../../../examples/demo-shop/api/server.mjs";
import { createProgram } from "../program.js";

const PASSWORD = "fictional-demo-password";
const draft = readFileSync(new URL("../../../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8");
const analysis = JSON.stringify({
  summary: "Cart API.",
  change_type: ["api"],
  endpoints: [{ method: "GET", path: "/cart", source: [{ kind: "ac", id: "AC1" }] }],
  confidence: "high",
});
const inProcess: AttemptExecutor = async (input) => {
  const { transport, dispose } = await createPlaywrightTransport({ timeoutMs: 5000 });
  try {
    return await executeAttempt(input, transport);
  } finally {
    await dispose();
  }
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A project whose environment answers /version with `deployed(sha, merged)`; readiness as given. */
const setup = async (
  deployed: (change: string, merged: string, older: string) => string,
  readiness: string,
) => {
  const { home, project, sha } = await createCliProject(["models: { roles: { default: mock/scripted } }"]);
  const repo = join(home, "git", "demo-org", "demo-shop");
  const g = (...args: string[]) =>
    gitExec(["-C", repo, "-c", "user.name=qa", "-c", "user.email=qa@example.com", ...args]);
  const older = (await g("rev-parse", "HEAD")).stdout.trim();
  // The change merged into main: the deployed main contains it.
  await g("merge", "-q", "--no-ff", "feature/DEMO-1-cart-discounts", "-m", "Merge DEMO-1");
  const merged = (await g("rev-parse", "HEAD")).stdout.trim();
  const shop = await startShop({
    env: { DEMO_USER_PASSWORD: PASSWORD, DEMO_SHA: deployed(sha, merged, older) },
  });
  cleanups.push(
    () => shop.close(),
    () => rm(home, { recursive: true, force: true }),
  );
  const yaml = join(project, ".qa", "qa.project.yaml");
  await writeFile(
    yaml,
    (await readFile(yaml, "utf8")).replace(
      "environments: { allowlist: ['http://localhost:3000'] }",
      `environments:\n  default: local\n  allowlist: ['${shop.url}']\n  readiness:\n${readiness}`,
    ),
  );
  await mkdir(join(project, ".qa", "envs"));
  await writeFile(
    join(project, ".qa", "envs", "local.yaml"),
    `base_url: ${shop.url}\naccounts:\n  user:standard: { username: standard, password: secret://env/DEMO_USER_PASSWORD }\nlogin:\n  path: /auth/login\n  body: { username: "{{username}}", password: "{{password}}" }\n  token_path: token\n`,
  );
  const sleeps: number[] = [];
  const run = async (args: string[], script: Turn[] = [{ text: "{}" }]) => {
    let out = "";
    let err = "";
    let exitCode = 0;
    const model = scriptedModel(script);
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
        now: () => new Date("2026-10-31T10:46:00Z"),
        random: () => 0,
        fetch: globalThis.fetch,
        gitExec,
        extraModels: { mock: () => model.mock },
        executor: inProcess,
        sleep: (ms: number) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
    })
      .exitOverride()
      .parseAsync(["node", "qj", ...args]);
    return { out, err, exitCode };
  };
  const runDir = join(home, "runs", "DEMO-1", "20261031-1046-aaaa");
  expect((await run(["fetch", "DEMO-1"])).exitCode).toBe(0);
  expect((await run(["plan", "DEMO-1"], [{ text: analysis }, { text: draft }])).exitCode).toBe(0);
  expect((await run(["approve", "DEMO-1"])).exitCode).toBe(0);
  for (const id of ["TC-01", "TC-02"])
    await copyFile(
      fileURLToPath(new URL(`../../../../fixtures/specs/demo-1/${id}.spec.ts`, import.meta.url)),
      join(runDir, "specs", `${id}.spec.ts`),
    );
  const record = async () =>
    (JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as { data: Record<string, unknown> }).data;
  return { run, runDir, record, sleeps, sha, project };
};

const checks = [
  "    versions: { shop: { url: /version, sha: sha } }",
  "    checks:",
  "      - { name: api health, url: /health, json: status, equals: ok }",
  "      - { name: test accounts, accounts: [user:standard] }",
].join("\n");

describe("environment readiness before the first case (REQ-ENV-13)", () => {
  it("REQ-ENV-13/AC1+AC2+AC3: a deployed main that contains the change is ready; the report is in run.json and report.html", async () => {
    const { run, runDir, record } = await setup((_, merged) => merged, checks);
    const r = await run(["run", "DEMO-1"]);
    expect(r.out).toContain("Environment readiness: READY");
    expect(r.out).toMatch(/✔ version of shop: deployed [0-9a-f]{12} contains the change/);
    expect(r.out).toContain('✔ api health: status = "ok"');
    expect(r.out).toContain("✔ test accounts: user:standard logged in");
    const data = await record();
    expect(data["readiness_env"]).toMatchObject({ ready: true, rounds: 1 });
    expect(Object.values(data["results"] as Record<string, string>)).toEqual(["PASSED", "PASSED"]);
    const html = await readFile(join(runDir, "report", "report.html"), "utf8");
    expect(html).toContain("Environment readiness: <strong>ready (3 check(s))</strong>");
    expect(html).toMatch(/<li class="ok">✔ version of shop: deployed [0-9a-f]{12} contains the change<\/li>/);
    const events = parseEventLines(await readFile(join(runDir, "journal", "events.jsonl"), "utf8")).events;
    expect(events.find((e) => e.event === "env.readiness")?.details).toEqual({
      ready: true,
      rounds: 1,
      failed: [],
    });
  }, 120_000);

  it("REQ-ENV-13/AC1+AC4: an older deployment is a named mismatch; no case runs, every case is BLOCKED with the reason", async () => {
    const { run, record } = await setup((_, __, older) => older, checks);
    const r = await run(["run", "DEMO-1"]);
    expect(r.err).toMatch(
      /The environment is not ready for DEMO-1 \(version of shop: deployed [0-9a-f]{12} does not contain the change \(older or another branch\)\); every case is BLOCKED/,
    );
    expect(r.exitCode).not.toBe(0);
    const data = await record();
    expect(Object.values(data["results"] as Record<string, string>)).toEqual(["BLOCKED", "BLOCKED"]);
    expect(data["readiness_env"]).toMatchObject({ ready: false });
  }, 120_000);

  it("REQ-ENV-13/AC4: while the deployment is awaited it is checked again; the timeout ends it BLOCKED", async () => {
    const waiting = `${checks}\n    wait: { timeout_s: 90, interval_s: 30 }`;
    const { run, record, sleeps } = await setup((_, __, older) => older, waiting);
    const r = await run(["run", "DEMO-1"]);
    expect(r.out).toContain("not ready yet (version of shop); checking again in 30 s");
    expect(sleeps).toEqual([30_000, 30_000, 30_000]);
    expect(await record()).toMatchObject({ readiness_env: { ready: false, rounds: 4 } });
  }, 120_000);

  it("REQ-ENV-13/AC5: a person runs anyway with a reason; results are marked environment not confirmed and the release is not ready", async () => {
    const { run, runDir, record, project } = await setup(() => "f".repeat(40), checks);
    const r = await run([
      "run",
      "DEMO-1",
      "--env-not-confirmed",
      "staging deploy is stuck, testing the API anyway",
    ]);
    expect(r.out).toContain("run anyway by qa-lead: staging deploy is stuck, testing the API anyway");
    const data = await record();
    expect(data["readiness_env"]).toMatchObject({
      ready: false,
      override: { by: "qa-lead", reason: "staging deploy is stuck, testing the API anyway" },
    });
    expect(Object.values(data["results"] as Record<string, string>)).toEqual(["PASSED", "PASSED"]);
    const html = await readFile(join(runDir, "report", "report.html"), "utf8");
    expect(html).toContain("environment not confirmed: run by qa-lead although not ready (version of shop)");
    // A release never counts a run on an environment nobody confirmed as verified (REQ-PUB-09).
    const ticket = join(project, "tickets", "DEMO-1.json");
    await writeFile(
      ticket,
      JSON.stringify({ ...(JSON.parse(await readFile(ticket, "utf8")) as object), fixVersions: ["2.4"] }),
    );
    const release = await run(["release", "2.4"]);
    expect(release.exitCode).toBe(1);
    expect(release.out).toContain("0 of 1 ticket(s) ready, 1 untrusted.");
    expect(release.out).toContain("environment not confirmed: run by qa-lead");
  }, 120_000);
});
