import { readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPlaywrightTransport, executeAttempt, type AttemptExecutor } from "@qajitsu/adapter-runner-api";
import { startShop } from "../../examples/demo-shop/api/server.mjs";
import { createProgram } from "../../packages/cli/src/program.js";
import { createCliProject, gitExec } from "./cli-project.js";
import { scriptedModel, type Turn } from "./mock-model.js";

export const DEMO_PASSWORD = "fictional-demo-password";
const draft = readFileSync(new URL("../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8");
const analysis = JSON.stringify({
  summary: "Cart API.",
  change_type: ["api"],
  endpoints: [{ method: "GET", path: "/cart", source: [{ kind: "ac", id: "AC1" }] }],
  confidence: "high",
});
const specFixture = (id: string): string =>
  fileURLToPath(new URL(`../../fixtures/specs/demo-1/${id}.spec.ts`, import.meta.url));

/** In-process executor for CLI tests (the sandbox has its own e2e tests). */
export const inProcessExecutor: AttemptExecutor = async (input) => {
  const { transport, dispose } = await createPlaywrightTransport({ timeoutMs: 5000 });
  try {
    return await executeAttempt(input, transport);
  } finally {
    await dispose();
  }
};

/**
 * A DEMO-1 project with a running demo-shop, ready for `fetch → plan → approve → run` through the
 * CLI program (no network beyond localhost, scripted models). Call `cleanup` in afterEach.
 */
export async function createDemoPipeline(options: { flag?: string } = {}) {
  const shop = await startShop({
    env: { DEMO_USER_PASSWORD: DEMO_PASSWORD, ...(options.flag ? { [options.flag]: "1" } : {}) },
  });
  const { home, project } = await createCliProject(["models: { roles: { default: mock/scripted } }"]);
  const yaml = join(project, ".qa", "qa.project.yaml");
  await writeFile(
    yaml,
    (await readFile(yaml, "utf8")).replace(
      "environments: { allowlist: ['http://localhost:3000'] }",
      `environments: { default: local, allowlist: ['${shop.url}'] }`,
    ),
  );
  await mkdir(join(project, ".qa", "envs"));
  await writeFile(
    join(project, ".qa", "envs", "local.yaml"),
    `base_url: ${shop.url}\naccounts:\n  user:standard: { username: standard, password: secret://env/DEMO_USER_PASSWORD }\nlogin:\n  path: /auth/login\n  body: { username: "{{username}}", password: "{{password}}" }\n  token_path: token\n`,
  );
  const run = async (
    args: string[],
    opts: { script?: Turn[]; ask?: string[]; fetch?: typeof globalThis.fetch } = {},
  ) => {
    let out = "";
    let err = "";
    let exitCode = 0;
    const model = scriptedModel(opts.script ?? [{ text: "{}" }]);
    const answers = [...(opts.ask ?? [])];
    await createProgram("1.0.0", {
      write: (t) => (out += t),
      writeError: (t) => (err += t),
      cwd: project,
      nodeVersion: "v22.22.0",
      setExitCode: (c) => (exitCode = c),
      user: "qa-lead",
      ...(opts.ask ? { ask: () => Promise.resolve(answers.shift() ?? "") } : {}),
      ports: {
        env: { DEMO_USER_PASSWORD: DEMO_PASSWORD },
        home,
        now: () => new Date("2026-10-03T10:46:00Z"),
        random: () => 0,
        fetch: opts.fetch ?? globalThis.fetch,
        gitExec,
        extraModels: { mock: () => model.mock },
        executor: inProcessExecutor,
      },
    })
      .exitOverride()
      .parseAsync(["node", "qj", ...args]);
    return { out, err, exitCode };
  };
  const runDir = join(home, "runs", "DEMO-1", "20261003-1046-aaaa");
  /** fetch, plan, approve, copy fixture specs and run. */
  const executed = async () => {
    await run(["fetch", "DEMO-1"]);
    await run(["plan", "DEMO-1"], { script: [{ text: analysis }, { text: draft }] });
    await run(["approve", "DEMO-1"]);
    for (const id of ["TC-01", "TC-02"])
      await copyFile(specFixture(id), join(runDir, "specs", `${id}.spec.ts`));
    return run(["run", "DEMO-1"]);
  };
  const cleanup = async () => {
    await shop.close();
    await rm(home, { recursive: true, force: true });
  };
  return { run, runDir, executed, cleanup, project, home };
}
