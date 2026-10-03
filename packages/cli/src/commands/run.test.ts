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
const specFixture = (id: string) =>
  fileURLToPath(new URL(`../../../../fixtures/specs/demo-1/${id}.spec.ts`, import.meta.url));

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

const setup = async (
  options: { flag?: string; sha?: string; mismatch?: "fail" | "warn"; profile?: string } = {},
) => {
  const shop = await startShop({
    env: {
      DEMO_USER_PASSWORD: PASSWORD,
      ...(options.flag ? { [options.flag]: "1" } : {}),
      ...(options.sha ? { DEMO_SHA: options.sha } : {}),
    },
  });
  const { home, project, sha } = await createCliProject(["models: { roles: { default: mock/scripted } }"]);
  cleanups.push(
    () => shop.close(),
    () => rm(home, { recursive: true, force: true }),
  );
  const yamlFile = join(project, ".qa", "qa.project.yaml");
  await writeFile(
    yamlFile,
    (await readFile(yamlFile, "utf8")).replace(
      "environments: { allowlist: ['http://localhost:3000'] }",
      `environments: { default: local, version_endpoint: /version, allowlist: ['${shop.url}'], on_version_mismatch: ${options.mismatch ?? "warn"} }`,
    ),
  );
  await mkdir(join(project, ".qa", "envs"));
  await writeFile(
    join(project, ".qa", "envs", "local.yaml"),
    options.profile ??
      `base_url: ${shop.url}\naccounts:\n  user:standard: { username: standard, password: secret://env/DEMO_USER_PASSWORD }\nlogin:\n  path: /auth/login\n  body: { username: "{{username}}", password: "{{password}}" }\n  token_path: token\n`,
  );
  const run = async (args: string[], script: Turn[] = [{ text: "{}" }], ask?: string[]) => {
    let out = "";
    let err = "";
    let exitCode = 0;
    const model = scriptedModel(script);
    const answers = [...(ask ?? [])];
    await createProgram("1.0.0", {
      write: (t) => (out += t),
      writeError: (t) => (err += t),
      cwd: project,
      nodeVersion: "v22.22.0",
      setExitCode: (c) => (exitCode = c),
      user: "qa-lead",
      ...(ask ? { ask: () => Promise.resolve(answers.shift() ?? "") } : {}),
      ports: {
        env: { DEMO_USER_PASSWORD: PASSWORD },
        home,
        now: () => new Date("2026-10-03T10:46:00Z"),
        random: () => 0,
        fetch: globalThis.fetch,
        gitExec,
        extraModels: { mock: () => model.mock },
        executor: inProcess,
      },
    })
      .exitOverride()
      .parseAsync(["node", "qj", ...args]);
    return { out, err, exitCode };
  };
  const runDir = join(home, "runs", "DEMO-1", "20261003-1046-aaaa");
  const prepare = async (withSpecs = true) => {
    expect((await run(["fetch", "DEMO-1"])).exitCode).toBe(0);
    expect((await run(["plan", "DEMO-1"], [{ text: analysis }, { text: draft }])).exitCode).toBe(0);
    expect((await run(["approve", "DEMO-1"])).exitCode).toBe(0);
    if (withSpecs)
      for (const id of ["TC-01", "TC-02"])
        await copyFile(specFixture(id), join(runDir, "specs", `${id}.spec.ts`));
  };
  return { run, runDir, prepare, sha, shop, project };
};

describe("qajitsu run (stage 3: REQ-EXEC-*, REQ-ENV-*, REQ-VER-07, REQ-EVD-05)", () => {
  it("REQ-NFR-04: without bugs every case PASSES with evidence, reports and exit code 0", async () => {
    const { run, runDir, prepare } = await setup();
    await prepare();
    const result = await run(["run", "DEMO-1"]);
    expect(result.err).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain("**2 cases: 2 PASSED**");
    for (const f of ["matrix.md", "matrix.csv", "matrix.xlsx", "report.html", "gates.json"])
      await readFile(join(runDir, "report", f));
    const gates = JSON.parse(await readFile(join(runDir, "report", "gates.json"), "utf8")) as { ok: boolean };
    expect(gates.ok).toBe(true);
    const html = await readFile(join(runDir, "report", "report.html"), "utf8");
    expect(html).not.toContain(PASSWORD);
    const events = parseEventLines(await readFile(join(runDir, "journal", "events.jsonl"), "utf8"));
    expect(events.invalidLines).toEqual([]);
    expect(events.events.map((e) => e.event)).toEqual(
      expect.arrayContaining(["env.health", "step", "verify", "case.attempt.end", "stage.end"]),
    );
    expect(JSON.stringify(events.events)).not.toContain(PASSWORD);
  });

  it("REQ-NFR-04: BUG-01 makes TC-01 FAILED (exit code 1) with expected and actual in the report", async () => {
    const { run, runDir, prepare } = await setup({ flag: "BUG_CART_TOTAL_ROUNDING" });
    await prepare();
    const result = await run(["run", "DEMO-1"]);
    expect(result.exitCode).toBe(1);
    expect(result.out).toContain("| TC-01 | Cart total is rounded once | AC1 | API | FAILED | 0/1 |");
    const html = await readFile(join(runDir, "report", "report.html"), "utf8");
    expect(html).toContain("<td><code>1.01</code></td><td><code>1.02</code></td>");
  });

  it("REQ-NFR-04: BUG-04 makes TC-02 FAILED", async () => {
    const { run, prepare } = await setup({ flag: "BUG_DISCOUNT_STACKS" });
    await prepare();
    const result = await run(["run", "DEMO-1"]);
    expect(result.exitCode).toBe(1);
    expect(result.out).toContain("| TC-02 | Second code replaces the first | quote | API | FAILED |");
  });

  it("REQ-EXEC-01 + REQ-EXEC-03/AC4: the author writes missing specs; a case without a valid spec is BLOCKED", async () => {
    const { run, prepare } = await setup();
    await prepare(false);
    const tc1 = readFileSync(specFixture("TC-01"), "utf8");
    const result = await run(["run", "DEMO-1"], [{ text: "```ts\n" + tc1 + "```" }, { text: "no code" }]);
    expect(result.exitCode).toBe(2);
    expect(result.out).toContain("| TC-01 | Cart total is rounded once | AC1 | API | PASSED |");
    expect(result.out).toContain("| TC-02 | Second code replaces the first | quote | API | BLOCKED |");
  });

  it("REQ-ENV-01/AC1: an unhealthy environment makes every case BLOCKED", async () => {
    const { run, prepare, shop } = await setup();
    await prepare();
    await shop.close();
    const result = await run(["run", "DEMO-1"]);
    expect(result.exitCode).toBe(2);
    expect(result.err).toContain("every case is BLOCKED");
    expect(result.out).toContain("**2 cases: 2 BLOCKED**");
  });

  it("REQ-ENV-02/AC2+AC3: a deployed version mismatch warns, fails in CI when configured, asks interactively", async () => {
    const warn = await setup({ sha: "deadbeef" });
    await warn.prepare();
    const warned = await warn.run(["run", "DEMO-1"]);
    expect(warned.err).toContain("Warning: Environment runs deadbeef");
    const record = JSON.parse(await readFile(join(warn.runDir, "run.json"), "utf8")) as {
      data: { environment: { deployedSha: string; versionCheck: string } };
    };
    expect(record.data.environment).toMatchObject({ deployedSha: "deadbeef", versionCheck: "mismatch" });

    const fail = await setup({ sha: "deadbeef", mismatch: "fail" });
    await fail.prepare();
    expect((await fail.run(["run", "DEMO-1"])).err).toContain("[ENV_VERSION_MISMATCH]");

    const asked = await setup({ sha: "deadbeef" });
    await asked.prepare();
    expect((await asked.run(["run", "DEMO-1"], undefined, ["n"])).err).toContain("Aborted");
  });

  it("REQ-ENV-01/AC2: --env <url> outside the allowlist is refused before any request", async () => {
    const { run, prepare } = await setup();
    const other = await startShop({ env: { DEMO_USER_PASSWORD: PASSWORD } });
    cleanups.push(() => other.close());
    await prepare();
    const result = await run(["run", "DEMO-1", "--env", other.url]);
    expect(result.exitCode).toBe(3);
    expect(result.err).toContain("[ENV_NOT_ALLOWED]");
  });

  it("REQ-PLAN-06/AC3: a changed approved plan blocks the run; a second run of the same run id is refused", async () => {
    const { run, runDir, prepare } = await setup();
    await prepare();
    expect((await run(["run", "DEMO-1"])).exitCode).toBe(0);
    expect((await run(["run", "DEMO-1"])).err).toContain("[RUN_ALREADY_EXECUTED]");
    const file = join(runDir, "plan", "plan.approved.yaml");
    const record = join(runDir, "run.json");
    const data = JSON.parse(await readFile(record, "utf8")) as { data: Record<string, unknown> };
    delete data.data["results"];
    await writeFile(record, JSON.stringify(data));
    await writeFile(file, (await readFile(file, "utf8")).replace("1.01", "1.02"));
    expect((await run(["run", "DEMO-1"])).err).toContain("[PLAN_HASH_MISMATCH]");
  });

  it("REQ-ENV-07/AC2: without a default environment an interactive run asks; CI fails", async () => {
    const { run, prepare, project } = await setup();
    await prepare();
    const yaml = join(project, ".qa", "qa.project.yaml");
    await writeFile(yaml, (await readFile(yaml, "utf8")).replace("default: local, ", ""));
    expect((await run(["run", "DEMO-1"])).err).toContain("[ENV_NOT_SELECTED]");
    const asked = await run(["run", "DEMO-1"], undefined, ["local"]);
    expect(asked.exitCode).toBe(0);
  });
});
