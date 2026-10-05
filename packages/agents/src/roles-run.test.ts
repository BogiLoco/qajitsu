import { readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import {
  createEventLog,
  parseEventLines,
  parseProjectConfig,
  writePlanVersion,
  type RunWorkspace,
} from "@qajitsu/core";
import { createModelRegistry, type ResolvedModel } from "@qajitsu/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promptOf, scriptedModel, type Turn } from "../../../tests/support/mock-model.js";
import { createFetchedRun } from "../../../tests/support/run-fixture.js";
import { buildChangeContext } from "./context.js";
import { modelForRole, runAnalyst, runPlanner, type AgentStageDeps } from "./roles-run.js";
import { createUsageTracker } from "./usage.js";

const analysis = {
  summary: "Cart total rounding and discount codes in the cart API.",
  change_type: ["api"],
  endpoints: [
    {
      method: "GET",
      path: "/cart",
      source: [
        { kind: "ac", id: "AC1" },
        { kind: "diff", repo: "shop", file: "src/cart/total.ts", lines: "1-4" },
      ],
    },
  ],
  screens: [],
  risks: [
    {
      description: "Rounding per line instead of once",
      source: [{ kind: "comment", repo: "shop", index: 0 }],
    },
  ],
  confidence: "high",
  open_questions: [],
};
const draft = JSON.parse(
  readFileSync(new URL("../../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

describe("analyst and planner (REQ-PLAN-01..05, REQ-LLM-03)", () => {
  let root: string;
  let ws: RunWorkspace;
  let lines: string[];
  beforeEach(async () => {
    ({ root, ws } = await createFetchedRun());
    lines = [];
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const deps = (
    models: Record<string, ResolvedModel>,
    roles: Record<string, string> = { default: "m/analyst", planner: "m/planner" },
  ): AgentStageDeps => {
    const config = parseProjectConfig({
      project: "demo",
      jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
      models: { roles },
    }).models;
    const events = createEventLog({
      ticket: "DEMO-1",
      run: ws.runId,
      write: (l) => lines.push(l),
      now: () => new Date(0),
      mask: (v) => v,
    });
    return {
      ws,
      models: {
        forRole: (role) =>
          Promise.resolve(models[(config.roles[role] ?? config.roles["default"] ?? "").split("/")[1] ?? ""]!),
        resolve: () => Promise.reject(new Error("unused")),
      },
      events,
      usage: createUsageTracker({ events }),
      now: () => new Date(0),
      maskJson: (v) => v,
      maskText: (t) => t,
    };
  };

  it("REQ-PLAN-01/AC1+AC2: the analyst explores code with guarded tools and writes a grounded analysis.json", async () => {
    const analyst = scriptedModel([
      { tools: [{ name: "read_file", input: { path: "repos/shop/src/cart/total.ts" } }] },
      { text: JSON.stringify(analysis) },
    ]);
    const result = await runAnalyst(deps({ analyst }), await buildChangeContext(ws));
    expect(result.change_type).toEqual(["api"]);
    expect(JSON.parse(await readFile(ws.path("analysis.json"), "utf8"))).toEqual(result);
    expect(promptOf(analyst, 1)).toContain("1: export function total()");
    const events = parseEventLines(lines.join("")).events.map((e) => e.event);
    expect(events).toEqual(["stage.start", "tool_allowed", "tool_result", "model.usage", "stage.end"]);
  });

  it("REQ-PLAN-01/AC2: ungrounded claims are sent back for repair", async () => {
    const invented = {
      ...analysis,
      risks: [
        {
          description: "Admins get free shipping",
          source: [{ kind: "quote", text: "Admins get free shipping" }],
        },
      ],
    };
    const analyst = scriptedModel([{ text: JSON.stringify(invented) }, { text: JSON.stringify(analysis) }]);
    await runAnalyst(deps({ analyst }), await buildChangeContext(ws));
    expect(promptOf(analyst, 1)).toContain("risks.0: source");
    expect(promptOf(analyst, 1)).toContain("not verbatim in the ticket snapshot");
  });

  it("REQ-CTX-06/AC2: the planner sees the existing tests and may only claim coverage by tests that exist", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(ws.path("repos", "e2e", "tests"), { recursive: true });
    await writeFile(
      ws.path("repos", "e2e", "tests", "discounts.spec.ts"),
      'test("an unknown code returns 404 and keeps the total", async () => {});\n',
    );
    await ws.update({
      repos: {
        ...ws.record.repos,
        e2e: { host: "github", path: "demo-org/shop-tests", sha: "abc1234", role: "tests" },
      },
    });
    const claim = (title: string) => ({
      ...draft,
      existing_coverage: [{ repo: "e2e", file: "tests/discounts.spec.ts", title, covers: ["AC4"] }],
    });
    const planner = scriptedModel([
      { text: JSON.stringify(claim("unknown codes are rejected")) },
      { text: JSON.stringify(claim("an unknown code returns 404 and keeps the total")) },
    ]);
    const context = await buildChangeContext(ws);
    expect(context.repos.map((r) => r.alias)).toEqual(["shop"]);
    const value = await runPlanner(deps({ planner, analyst: planner }), context, analysis as never);
    expect(promptOf(planner, 0)).toContain("## Tests repository 'e2e'");
    expect(promptOf(planner, 0)).toContain(
      'tests/discounts.spec.ts: \\"an unknown code returns 404 and keeps the total\\"',
    );
    expect(promptOf(planner, 1)).toContain(
      "existing_coverage.0: no test 'unknown codes are rejected' in e2e:tests/discounts.spec.ts",
    );
    expect(value.existing_coverage).toEqual([
      {
        repo: "e2e",
        file: "tests/discounts.spec.ts",
        title: "an unknown code returns 404 and keeps the total",
        covers: ["AC4"],
      },
    ]);
  });

  it("REQ-PLAN-02 + REQ-PLAN-03: the planner returns a validated, grounded draft that is stored as a version", async () => {
    const planner = scriptedModel([{ text: JSON.stringify(draft) }]);
    const value = await runPlanner(
      deps({ planner, analyst: planner }),
      await buildChangeContext(ws),
      analysis as never,
    );
    const plan = await writePlanVersion(ws, value);
    expect(plan.cases.map((c) => c.id)).toEqual(["TC-01", "TC-02"]);
    expect(promptOf(planner, 0)).toContain("## Analysis");
  });

  it("REQ-PLAN-04/AC1: a revision passes the current plan and the reviewer's instruction", async () => {
    const planner = scriptedModel([{ text: JSON.stringify(draft) }]);
    const context = await buildChangeContext(ws);
    const v1 = await writePlanVersion(
      ws,
      await runPlanner(deps({ planner, analyst: planner }), context, analysis as never),
    );
    const reviser = scriptedModel([
      { text: JSON.stringify({ ...draft, cases: (draft["cases"] as unknown[]).slice(0, 1) }) },
    ]);
    const revised = await runPlanner(
      deps({ planner: reviser, analyst: reviser }),
      context,
      analysis as never,
      { previous: v1, instruction: "Drop TC-02, it duplicates TC-01." },
    );
    expect(revised.cases).toHaveLength(1);
    expect(promptOf(reviser, 0)).toContain("Drop TC-02, it duplicates TC-01.");
    expect(promptOf(reviser, 0)).toContain("Current plan v1");
  });

  it("REQ-LLM-03/AC3: a role cannot run on a model missing a required capability", async () => {
    const weak = scriptedModel([{ text: "{}" }], { tools: false, contextWindow: 8_192 });
    await expect(modelForRole(deps({ analyst: weak }).models, "analyst")).rejects.toMatchObject({
      code: "MODEL_CAPABILITY_MISSING",
      context: { missing: ["tools", "contextWindow>=64000"] },
    });
  });

  it("works with a registry-built model (no network: mock provider)", async () => {
    const config = parseProjectConfig({
      project: "demo",
      jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
      models: { roles: { default: "mock/x" } },
    }).models;
    const script: Turn[] = [{ text: JSON.stringify(analysis) }];
    const scripted = scriptedModel(script);
    const registry = createModelRegistry({
      config,
      resolveSecret: () => Promise.resolve(""),
      extra: { mock: () => scripted.mock },
    });
    const d = { ...deps({}), models: registry };
    expect((await runAnalyst(d, await buildChangeContext(ws))).confidence).toBe("high");
  });
});
