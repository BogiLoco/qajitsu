#!/usr/bin/env node
// The whole QAJitsu flow on the fictional demo-shop with one command (REQ-NFR-06/AC3):
//   pnpm demo                              offline: recorded model answers, no API key, no Docker
//   pnpm demo -- --model ollama/<model>    the same flow with a live model (configure it in models.providers)
// It runs DEMO-1 twice: on the clean app (every case PASSED) and with seeded bug BUG-01 switched on (TC-01 FAILED).
// Runs go to a temporary workspace; the local demo git repository is (re)created in ~/.qa-demo/git.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const shopDir = join(root, "examples", "demo-shop");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const liveModel = arg("--model");
const keep = process.argv.includes("--keep");
const PASSWORD = process.env.DEMO_USER_PASSWORD ?? "demo-password";

const { createProgram } = await import(join(root, "packages", "cli", "dist", "program.js"));
const { createGitExec } = await import(join(root, "packages", "core", "dist", "index.js"));
const { startShop } = await import(join(shopDir, "api", "server.mjs"));
const require = createRequire(join(root, "packages", "agents", "package.json"));
const { MockLanguageModelV4 } = await import(require.resolve("ai/test"));

const fixture = (path) => readFileSync(join(root, "fixtures", path), "utf8");
const ANALYSIS = JSON.stringify({
  summary: "Cart total rounding and discount codes in the cart API.",
  change_type: ["api"],
  endpoints: [{ method: "GET", path: "/cart", source: [{ kind: "ac", id: "AC1" }] }],
  confidence: "high",
});

/**
 * Recorded answers for the offline demo, picked by the role in the system prompt: the analysis, the DEMO-1 plan,
 * the reviewed spec of each case and an auditor that raises no doubt. Never used outside this script.
 */
const recorded = () =>
  new MockLanguageModelV4({
    doGenerate: ({ prompt }) => {
      const system = prompt.find((m) => m.role === "system")?.content ?? "";
      const user = JSON.stringify(prompt.filter((m) => m.role !== "system"));
      const caseId = /Write the spec for (TC-\d+)/.exec(user)?.[1];
      const text = system.includes("You are the analyst")
        ? ANALYSIS
        : system.includes("test planner")
          ? fixture("plans/demo-1-draft.json")
          : system.includes("test author") && caseId
            ? "```ts\n" + fixture(`specs/demo-1/${caseId}.spec.ts`) + "```"
            : system.includes("auditor")
              ? JSON.stringify({
                  // One finding per PASSED case the auditor was shown; the recorded answer raises no doubt.
                  findings: [...new Set(user.match(/TC-\d{2,4}/g) ?? [])].map((caseId) => ({
                    caseId,
                    weak: false,
                    reason: "recorded demo answer: the evidence matches the plan",
                  })),
                })
              : "{}";
      return Promise.resolve({
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      });
    },
  });

const workspace = mkdtempSync(join(tmpdir(), "qajitsu-demo-"));
// The project loader reads QAJITSU_WORKSPACE from the process environment.
process.env.QAJITSU_WORKSPACE = workspace;
// ADR-0006: the demo registers demo-shop as a project in a throw-away QAJitsu home, not in ~/.qajitsu.
process.env.QAJITSU_HOME = join(workspace, "qajitsu-home");
const env = { ...process.env, DEMO_USER_PASSWORD: PASSWORD };
const qj = async (...args) => {
  let code = 0;
  process.stdout.write(`\n$ qj ${args.join(" ")}\n`);
  await createProgram("demo", {
    write: (t) => process.stdout.write(t),
    writeError: (t) => process.stderr.write(t),
    cwd: shopDir,
    nodeVersion: process.version,
    setExitCode: (c) => {
      code = c;
    },
    user: "demo",
    ports: {
      env,
      home: homedir(),
      now: () => new Date(),
      random: Math.random,
      fetch: globalThis.fetch,
      gitExec: createGitExec(env),
      ...(liveModel ? { modelOverride: { ref: liveModel } } : { extraModels: { local: () => recorded() } }),
    },
  }).parseAsync(["node", "qj", ...args]);
  return code;
};
const latestRun = () => {
  const index = JSON.parse(readFileSync(join(workspace, "DEMO-1", "index.json"), "utf8"));
  return join(workspace, "DEMO-1", index.latest);
};

/** fetch, plan, approve and run DEMO-1 against the demo-shop API with the given bug flags. */
const cycle = async (title, bugs) => {
  process.stdout.write(`\n=== ${title} ===\n`);
  if ((await qj("fetch", "DEMO-1")) !== 0) throw new Error("fetch failed");
  const sha = JSON.parse(readFileSync(join(latestRun(), "run.json"), "utf8")).repos.shop.sha;
  // The API reports the fetched commit, so the deployed-version check matches (REQ-ENV-02).
  const shop = await startShop({ port: 3000, env: { DEMO_USER_PASSWORD: PASSWORD, DEMO_SHA: sha, ...bugs } });
  try {
    if ((await qj("plan", "DEMO-1")) !== 0) throw new Error("plan failed");
    if ((await qj("approve", "DEMO-1", "--approver", "demo")) !== 0) throw new Error("approve failed");
    const code = await qj("run", "DEMO-1", "--env", "local");
    const results = JSON.parse(readFileSync(join(latestRun(), "run.json"), "utf8")).data.results ?? {};
    return { code, results, report: join(latestRun(), "report", "report.html") };
  } finally {
    await shop.close();
  }
};

let ok = false;
try {
  process.stdout.write(
    liveModel
      ? `QAJitsu demo with the live model ${liveModel}.\n`
      : "QAJitsu demo, offline: the agents' answers are recorded (no API key, no network). Use --model for a live model.\n",
  );
  execFileSync(process.execPath, [join(shopDir, "scripts", "setup-demo-repo.mjs")], { stdio: "inherit" });
  // 0 ready, 2 registered with problems the demo does not need (e.g. Docker for --build).
  if (![0, 2].includes(await qj("init", "demo-shop", "--qa-dir", join(shopDir, ".qa"), "--yes")))
    throw new Error("init failed");
  const clean = await cycle("1. The clean app: every case must PASS", {});
  const buggy = await cycle("2. Seeded bug BUG-01 (cart total rounding): TC-01 must FAIL", {
    BUG_CART_TOTAL_ROUNDING: "1",
  });
  ok =
    clean.code === 0 &&
    Object.values(clean.results).every((s) => s === "PASSED") &&
    buggy.code === 1 &&
    buggy.results["TC-01"] === "FAILED";
  process.stdout.write(
    [
      "",
      "=== Result ===",
      `clean app:   ${JSON.stringify(clean.results)}${keep ? `  report ${clean.report}` : ""}`,
      `with BUG-01: ${JSON.stringify(buggy.results)}${keep ? `  report ${buggy.report}` : ""}`,
      ok
        ? "The bug was caught: the same test PASSED on the clean app and FAILED with the bug."
        : "Unexpected statuses.",
      keep
        ? `Runs kept in ${workspace} (QAJITSU_WORKSPACE=${workspace} qj evidence DEMO-1 --failed).`
        : "Add --keep to keep the runs and open their reports.",
      "",
    ].join("\n"),
  );
} catch (error) {
  process.stderr.write(`Demo failed: ${error instanceof Error ? error.message : String(error)}\n`);
} finally {
  if (!keep) rmSync(workspace, { recursive: true, force: true });
}
process.exitCode = ok ? 0 : 1;
