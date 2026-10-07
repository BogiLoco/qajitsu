import { readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPlaywrightTransport, executeAttempt, type AttemptExecutor } from "@qajitsu/adapter-runner-api";
import { createPlaywrightBrowserFactory } from "@qajitsu/adapter-runner-web";
import { startShop } from "../../examples/demo-shop/api/server.mjs";
import { createProgram } from "../../packages/cli/src/program.js";
import type { RunPorts } from "../../packages/cli/src/commands/run.js";
import { createCliProject, gitExec } from "./cli-project.js";
import { scriptedModel, type Turn } from "./mock-model.js";

export const DEMO_PASSWORD = "fictional-demo-password";
const draftOf = (ticket: string): string =>
  readFileSync(new URL(`../../fixtures/plans/${ticket.toLowerCase()}-draft.json`, import.meta.url), "utf8");
const analysis = JSON.stringify({
  summary: "Cart API.",
  change_type: ["api"],
  endpoints: [{ method: "GET", path: "/cart", source: [{ kind: "ac", id: "AC1" }] }],
  confidence: "high",
});
const specFixture = (ticket: string, id: string): string =>
  fileURLToPath(new URL(`../../fixtures/specs/${ticket.toLowerCase()}/${id}.spec.ts`, import.meta.url));

/**
 * Model turns of a whole `qj test` flow: analysis, the plan draft and one spec per planned case (the
 * fixture specs), in plan order.
 */
export const flowScript = (ticket: string): Turn[] => {
  const draft = draftOf(ticket);
  const ids = (JSON.parse(draft) as { cases: { id: string }[] }).cases.map((c) => c.id);
  return [
    { text: analysis },
    { text: draft },
    ...ids.map((id) => ({ text: "```ts\n" + readFileSync(specFixture(ticket, id), "utf8") + "```" })),
  ];
};

/** In-process executor for CLI tests (the sandbox has its own e2e tests). */
export const inProcessExecutor: AttemptExecutor = async (input) => {
  const { transport, dispose } = await createPlaywrightTransport({ timeoutMs: 5000 });
  try {
    return await executeAttempt(input, transport);
  } finally {
    await dispose();
  }
};

const webBrowser = createPlaywrightBrowserFactory({
  webSession: { storage: "sessionStorage", key: "token" },
  actionTimeoutMs: 3000,
});

/** In-process executor with a browser for web and mixed cases. */
export const inProcessWebExecutor: AttemptExecutor = async (input) => {
  const { transport, dispose } = await createPlaywrightTransport({ timeoutMs: 5000 });
  try {
    return await executeAttempt(input, transport, Date.now, webBrowser);
  } finally {
    await dispose();
  }
};

/**
 * A demo-shop project with a running demo-shop, ready for `fetch → plan → approve → run` through the
 * CLI program (no network beyond localhost, scripted models). Call `cleanup` in afterEach.
 */
export async function createDemoPipeline(
  options: {
    flag?: string;
    ticket?: string;
    wrapExecutor?: (executor: AttemptExecutor) => AttemptExecutor;
    /** Extra ports, e.g. `browserUnavailable` for the browser matrix. */
    ports?: Partial<RunPorts>;
    /** Changes the fixture plan draft before planning. */
    transformPlan?: (draft: string) => string;
    /** Changes a fixture spec before the run. */
    transformSpec?: (caseId: string, code: string) => string;
  } = {},
) {
  const ticket = options.ticket ?? "DEMO-1";
  const web = ticket === "DEMO-4" || ticket === "DEMO-5";
  const shop = await startShop({
    env: { DEMO_USER_PASSWORD: DEMO_PASSWORD, ...(options.flag ? { [options.flag]: "1" } : {}) },
  });
  const { home, project } = await createCliProject(["models: { roles: { default: mock/scripted } }"]);
  if (ticket !== "DEMO-1") {
    await copyFile(
      new URL(`../../examples/demo-shop/tickets/${ticket}.json`, import.meta.url),
      join(project, "tickets", `${ticket}.json`),
    );
  }
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
    `base_url: ${shop.url}\nweb_session: { storage: sessionStorage, key: token }\naccounts:\n  user:standard: { username: standard, password: secret://env/DEMO_USER_PASSWORD }\nlogin:\n  path: /auth/login\n  body: { username: "{{username}}", password: "{{password}}" }\n  token_path: token\n`,
  );
  const run = async (
    args: string[],
    opts: {
      script?: Turn[];
      ask?: string[];
      fetch?: typeof globalThis.fetch;
      compressVideo?: (input: string, output: string) => Promise<boolean>;
      signals?: RunPorts["signals"];
    } = {},
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
      ...(opts.compressVideo ? { compressVideo: opts.compressVideo } : {}),
      ports: {
        env: { DEMO_USER_PASSWORD: DEMO_PASSWORD },
        home,
        now: () => new Date("2026-10-03T10:46:00Z"),
        random: () => 0,
        fetch: opts.fetch ?? globalThis.fetch,
        gitExec,
        extraModels: { mock: () => model.mock },
        ...(opts.signals ? { signals: opts.signals } : {}),
        executor: (options.wrapExecutor ?? ((e: AttemptExecutor) => e))(
          web ? inProcessWebExecutor : inProcessExecutor,
        ),
        ...options.ports,
      },
    })
      .exitOverride()
      .parseAsync(["node", "qj", ...args]);
    return { out, err, exitCode };
  };
  const runDir = join(home, "runs", ticket, "20261003-1046-aaaa");
  /** fetch, plan, approve, copy fixture specs and run. */
  const executed = async () => {
    await run(["fetch", ticket, ...(ticket === "DEMO-1" ? [] : ["--ref", "shop=main"])]);
    const planDraft = (options.transformPlan ?? ((d: string) => d))(draftOf(ticket));
    await run(["plan", ticket], { script: [{ text: analysis }, { text: planDraft }] });
    await run(["approve", ticket]);
    const ids = (JSON.parse(planDraft) as { cases: { id: string }[] }).cases.map((c) => c.id);
    for (const id of ids) {
      const target = join(runDir, "specs", `${id}.spec.ts`);
      if (options.transformSpec)
        await writeFile(target, options.transformSpec(id, await readFile(specFixture(ticket, id), "utf8")));
      else await copyFile(specFixture(ticket, id), target);
    }
    return run(["run", ticket]);
  };
  const cleanup = async () => {
    await shop.close();
    await rm(home, { recursive: true, force: true });
  };
  return { run, runDir, executed, cleanup, project, home };
}
