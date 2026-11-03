// Self-test of QAJitsu on the demo-shop (REQ-NFR-04/AC1, REQ-NFR-02/AC3): every seeded API bug must end
// FAILED for its case, and the same case must be PASSED with the bug switched off. Full pipeline with
// the built, sandboxed API runner; models are scripted (no real LLM).
import { readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSandboxExecutor } from "@qajitsu/adapter-runner-api";
import { createPlaywrightBrowserFactory } from "@qajitsu/adapter-runner-web";
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
  // A web download checked in the production sandbox (the child gets every planned expectation, REQ-EXEC-38).
  {
    bug: "BUG-10",
    flag: "BUG_EXPORT_DROPS_LAST_ROW",
    ticket: "DEMO-7",
    caseId: "TC-03",
    specs: ["TC-01", "TC-02", "TC-03"],
  },
  // A multipart upload and a file response (REQ-EXEC-45).
  {
    bug: "BUG-21",
    flag: "BUG_DOCUMENT_TRUNCATED",
    ticket: "DEMO-16",
    caseId: "TC-01",
    specs: ["TC-01", "TC-02", "TC-03"],
  },
  // Records created for each attempt (REQ-EXEC-53): exactly three in stock is the boundary.
  {
    bug: "BUG-23",
    flag: "BUG_LOW_STOCK_OFF_BY_ONE",
    ticket: "DEMO-17",
    caseId: "TC-01",
    specs: ["TC-01", "TC-02"],
  },
  // GraphQL (REQ-EXEC-48): a price as text breaks the schema; an error next to the data fails even with HTTP 200.
  {
    bug: "BUG-24",
    flag: "BUG_GRAPHQL_PRICE_AS_TEXT",
    ticket: "DEMO-18",
    caseId: "TC-01",
    specs: ["TC-01", "TC-02", "TC-03"],
  },
  {
    bug: "BUG-25",
    flag: "BUG_GRAPHQL_ERROR_WITH_DATA",
    ticket: "DEMO-18",
    caseId: "TC-02",
    specs: ["TC-01", "TC-02", "TC-03"],
  },
  // An outcome that never comes: the planned wait ends at its timeout with FAILED (REQ-EXEC-46).
  {
    bug: "BUG-22",
    flag: "BUG_DOCUMENT_NEVER_READY",
    ticket: "DEMO-16",
    caseId: "TC-03",
    specs: ["TC-01", "TC-02", "TC-03"],
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
      ) +
        // REQ-EXEC-53: the demo's products for tests, as in examples/demo-shop/.qa/qa.project.yaml.
        [
          "",
          "test_data:",
          "  kinds:",
          "    product:",
          '      create: { request: "POST /admin/products", as: "user:admin" }',
          '      remove: { request: "DELETE /admin/products/{id}", as: "user:admin" }',
          '  cleanup: { request: "DELETE /admin/products?marker={marker}", as: "user:admin" }',
          "",
        ].join("\n"),
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
          executor: createSandboxExecutor({
            childScript,
            browser: createPlaywrightBrowserFactory({
              webSession: { storage: "sessionStorage", key: "token" },
            }),
          }),
        },
      })
        .exitOverride()
        .parseAsync(["node", "qj", ...args]);
      return { out, exitCode };
    };
    const ref = ticket === "DEMO-1" ? [] : ["--ref", "shop=main"];
    const fetched = await run(["fetch", ticket, ...ref]);
    expect(fetched.exitCode, fetched.out).toBe(0);
    const draft = readFileSync(fixture(`plans/${ticket.toLowerCase()}-draft.json`), "utf8");
    const analysis = JSON.stringify({ summary: "API change.", change_type: ["api"], confidence: "high" });
    const planned = await run(["plan", ticket], [{ text: analysis }, { text: draft }]);
    expect(planned.exitCode, planned.out).toBe(0);
    // The fixture plans were reviewed by people: elements that appear only after an action (the avatar's name after
    // the upload) are confirmed as a reviewer would.
    const approved = await run(["approve", ticket, "--confirm-placeholders"]);
    expect(approved.exitCode, approved.out).toBe(0);
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

  it.each([
    ["DEMO-1", ["TC-01", "TC-02"]],
    ["DEMO-2", ["TC-01", "TC-02"]],
    ["DEMO-3", ["TC-01", "TC-02"]],
    ["DEMO-4", ["TC-01", "TC-02"]],
    ["DEMO-5", ["TC-01"]],
    ["DEMO-7", ["TC-01", "TC-02", "TC-03"]],
    ["DEMO-16", ["TC-01", "TC-02", "TC-03"]],
    ["DEMO-17", ["TC-01", "TC-02"]],
    ["DEMO-18", ["TC-01", "TC-02", "TC-03"]],
  ] as const)("%s: every case is PASSED with all bugs off", async (ticket, specs) => {
    const { exitCode, statuses, out } = await pipeline(ticket, specs);
    expect(
      Object.values(statuses).every((s) => s === "PASSED"),
      `${JSON.stringify(statuses)}\n${out}`,
    ).toBe(true);
    expect(exitCode).toBe(0);
  });
});
