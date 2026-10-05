import { readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPlaywrightTransport, executeAttempt, type AttemptExecutor } from "@qajitsu/adapter-runner-api";
import type { CommandExec } from "@qajitsu/adapter-env-compose";
import { readRunIndex, type TicketKey } from "@qajitsu/core";
import { expect } from "vitest";
import { createProgram } from "../../packages/cli/src/program.js";
import type { RunPorts } from "../../packages/cli/src/commands/run.js";
import { createCliProject, gitExec } from "./cli-project.js";
import { scriptedModel, type Turn } from "./mock-model.js";

export const PASSWORD = "fictional-demo-password";
const draft = readFileSync(new URL("../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8");
const analysis = JSON.stringify({
  summary: "Cart API.",
  change_type: ["api"],
  endpoints: [{ method: "GET", path: "/cart", source: [{ kind: "ac", id: "AC1" }] }],
  confidence: "high",
});
const specFixture = (id: string) =>
  fileURLToPath(new URL(`../../fixtures/specs/demo-1/${id}.spec.ts`, import.meta.url));

const inProcess: AttemptExecutor = async (input) => {
  const { transport, dispose } = await createPlaywrightTransport({ timeoutMs: 5000 });
  try {
    return await executeAttempt(input, transport);
  } finally {
    await dispose();
  }
};

export const apiService = (command = '["node", "api/server.mjs", "--port", "{{port}}"]') =>
  [
    "services:",
    "  api:",
    "    kind: process",
    `    command: ${command}`,
    "    env:",
    "      DEMO_USER_PASSWORD: { secret: secret://env/DEMO_USER_PASSWORD }",
    '      BUG_CART_TOTAL_ROUNDING: { value: "0", overridable: true }',
    "    health: { http: /health, timeout_s: 20 }",
    "build: { repo: shop, base_service: api, profile: local, seed: hooks/seed.mjs }",
  ].join("\n");

/**
 * A demo-shop project whose repository contains the demo-shop API, configured for `qj run --build` with
 * a managed process (no Docker needed). Register `cleanup` in afterEach.
 */
export const createBuildProject = async (
  services = apiService(),
  options: {
    readonly buildExec?: CommandExec;
    readonly now?: () => Date;
    readonly ports?: Partial<RunPorts>;
  } = {},
) => {
  const { home, project } = await createCliProject(
    ["models: { roles: { default: mock/scripted } }", services],
    {
      withShopApi: true,
    },
  );
  await mkdir(join(project, ".qa", "envs"));
  await mkdir(join(project, ".qa", "hooks"));
  await copyFile(
    new URL("../../examples/demo-shop/.qa/hooks/seed.mjs", import.meta.url),
    join(project, ".qa", "hooks", "seed.mjs"),
  );
  // The profile's URL is never used by --build; accounts, login and the health path are.
  await writeFile(
    join(project, ".qa", "envs", "local.yaml"),
    `base_url: http://localhost:3000\nhealth_path: /health\naccounts:\n  user:standard: { username: standard, password: secret://env/DEMO_USER_PASSWORD }\nlogin:\n  path: /auth/login\n  body: { username: "{{username}}", password: "{{password}}" }\n  token_path: token\n`,
  );
  let seq = 0;
  const run = async (
    args: string[],
    script: Turn[] = [{ text: "{}" }],
    extra: { readonly env?: Readonly<Record<string, string>> } = {},
  ) => {
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
        env: { DEMO_USER_PASSWORD: PASSWORD, ...extra.env },
        home,
        now: options.now ?? (() => new Date()),
        random: () => ((seq += 7) % 36) / 36,
        fetch: globalThis.fetch,
        gitExec,
        extraModels: { mock: () => model.mock },
        executor: inProcess,
        ...(options.buildExec ? { buildExec: options.buildExec } : {}),
        ...options.ports,
      },
    })
      .exitOverride()
      .parseAsync(["node", "qj", ...args]);
    return { out, err, exitCode };
  };
  /** fetch, plan, approve and copy the fixture specs; returns the run folder. */
  const prepare = async (planDraft: string = draft): Promise<string> => {
    expect((await run(["fetch", "DEMO-1"])).exitCode).toBe(0);
    expect((await run(["plan", "DEMO-1"], [{ text: analysis }, { text: planDraft }])).exitCode).toBe(0);
    expect((await run(["approve", "DEMO-1"])).exitCode).toBe(0);
    const runId = (await readRunIndex(join(home, "runs"), "DEMO-1" as TicketKey)).latest ?? "";
    const dir = join(home, "runs", "DEMO-1", runId);
    for (const id of ["TC-01", "TC-02"]) await copyFile(specFixture(id), join(dir, "specs", `${id}.spec.ts`));
    return dir;
  };
  const cleanup = () => rm(home, { recursive: true, force: true });
  return { run, prepare, project, home, cleanup };
};

export const record = async (dir: string) =>
  JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as {
    data: Record<string, unknown> & { environment: Record<string, unknown> };
  };
