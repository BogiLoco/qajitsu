// Self-test of QAJitsu on the demo-shop (REQ-NFR-04/AC1, REQ-NFR-02/AC3): every seeded API bug must end
// FAILED for its case, and the same case must be PASSED with the bug switched off. Full pipeline with
// the built, sandboxed API runner; models are scripted (no real LLM).
import { readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSandboxExecutor } from "@qajitsu/adapter-runner-api";
import { describe, expect, it } from "vitest";
import { createCliProject, gitExec } from "../support/cli-project.js";
import { scriptedModel, type Turn } from "../support/mock-model.js";
import { startShop } from "../../examples/demo-shop/api/server.mjs";
import { createProgram } from "../../packages/cli/src/program.js";

const PASSWORD = "fictional-demo-password";
const childScript = fileURLToPath(
  new URL("../../packages/adapters/runner-api/dist/child.js", import.meta.url),
);
const fixture = (path: string) => fileURLToPath(new URL(`../../fixtures/${path}`, import.meta.url));

/** Seeded bug → ticket and the case that must catch it (examples/demo-shop/BUGS.md). */
const BUGS = [
  {
    bug: "BUG-01",
    flag: "BUG_CART_TOTAL_ROUNDING",
    ticket: "DEMO-1",
    caseId: "TC-01",
    specs: ["TC-01", "TC-02"],
  },
  {
    bug: "BUG-04",
    flag: "BUG_DISCOUNT_STACKS",
    ticket: "DEMO-1",
    caseId: "TC-02",
    specs: ["TC-01", "TC-02"],
  },
  {
    bug: "BUG-02",
    flag: "BUG_ORDER_ACCEPTS_NEGATIVE_QTY",
    ticket: "DEMO-2",
    caseId: "TC-01",
    specs: ["TC-01", "TC-02"],
  },
  {
    bug: "BUG-03",
    flag: "BUG_AUTH_EXPIRED_TOKEN_OK",
    ticket: "DEMO-3",
    caseId: "TC-02",
    specs: ["TC-01", "TC-02"],
  },
] as const;

async function pipeline(
  ticket: string,
  specs: readonly string[],
  flag?: string,
): Promise<{ exitCode: number; statuses: Record<string, string>; out: string }> {
  const shop = await startShop({
    env: { DEMO_USER_PASSWORD: PASSWORD, ...(flag ? { [flag]: "1" } : {}) },
  });
  const { home, project } = await createCliProject(["models: { roles: { default: mock/scripted } }"]);
  try {
    await copyFile(
      new URL(`../../examples/demo-shop/tickets/${ticket}.json`, import.meta.url),
      join(project, "tickets", `${ticket}.json`),
    );
    const yaml = join(project, ".qa", "qa.project.yaml");
    await writeFile(
      yaml,
      (await readFile(yaml, "utf8")).replace(
        "environments: { allowlist: ['http://localhost:3000'] }",
        `environments: { default: local, allowlist: ['${shop.url}'] }`,
      ),
    );
    await mkdir(join(project, ".qa", "envs"));
    const profile = readFileSync(
      new URL("../../examples/demo-shop/.qa/envs/local.yaml", import.meta.url),
      "utf8",
    ).replace("http://localhost:3000", shop.url);
    await writeFile(join(project, ".qa", "envs", "local.yaml"), profile);
    const run = async (args: string[], script: Turn[] = [{ text: "{}" }]) => {
      let out = "";
      let exitCode = 0;
      const model = scriptedModel(script);
      await createProgram("1.0.0", {
        write: (t) => (out += t),
        writeError: (t) => (out += t),
        cwd: project,
        nodeVersion: process.version,
        setExitCode: (c) => (exitCode = c),
        user: "e2e",
        ports: {
          env: { DEMO_USER_PASSWORD: PASSWORD },
          home,
          now: () => new Date(),
          random: Math.random,
          fetch: globalThis.fetch,
          gitExec,
          extraModels: { mock: () => model.mock },
          executor: createSandboxExecutor({ childScript }),
        },
      })
        .exitOverride()
        .parseAsync(["node", "qj", ...args]);
      return { out, exitCode };
    };
    const ref = ticket === "DEMO-1" ? [] : ["--ref", "shop=main"];
    expect((await run(["fetch", ticket, ...ref])).exitCode).toBe(0);
    const draft = readFileSync(fixture(`plans/${ticket.toLowerCase()}-draft.json`), "utf8");
    const analysis = JSON.stringify({ summary: "API change.", change_type: ["api"], confidence: "high" });
    const planned = await run(["plan", ticket], [{ text: analysis }, { text: draft }]);
    expect(planned.exitCode, planned.out).toBe(0);
    expect((await run(["approve", ticket])).exitCode).toBe(0);
    const runRoot = join(home, "runs", ticket);
    const latest = JSON.parse(await readFile(join(runRoot, "index.json"), "utf8")) as { latest: string };
    for (const id of specs)
      await copyFile(
        fixture(`specs/${ticket.toLowerCase()}/${id}.spec.ts`),
        join(runRoot, latest.latest, "specs", `${id}.spec.ts`),
      );
    const result = await run(["run", ticket]);
    const record = JSON.parse(await readFile(join(runRoot, latest.latest, "run.json"), "utf8")) as {
      data: { results: Record<string, string> };
    };
    return { exitCode: result.exitCode, statuses: record.data.results, out: result.out };
  } finally {
    await shop.close();
    await rm(home, { recursive: true, force: true });
  }
}

describe("demo-shop self-test (REQ-NFR-04/AC1)", () => {
  it.each(BUGS)("$bug: $ticket $caseId is FAILED with $flag on", async ({ flag, ticket, caseId, specs }) => {
    const { exitCode, statuses, out } = await pipeline(ticket, specs, flag);
    expect(statuses[caseId], out).toBe("FAILED");
    expect(exitCode).toBe(1);
  });

  it.each(["DEMO-1", "DEMO-2", "DEMO-3"])("%s: every case is PASSED with all bugs off", async (ticket) => {
    const { exitCode, statuses, out } = await pipeline(ticket, ["TC-01", "TC-02"]);
    expect(
      Object.values(statuses).every((s) => s === "PASSED"),
      `${JSON.stringify(statuses)}\n${out}`,
    ).toBe(true);
    expect(exitCode).toBe(0);
  });
});
