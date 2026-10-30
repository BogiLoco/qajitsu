import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildProject } from "../../../../tests/support/cli-build.js";
import { createFakeEmbedder } from "../../../../tests/support/fake-embedder.js";
import { promptOf, type Turn } from "../../../../tests/support/mock-model.js";
import { mkdir } from "node:fs/promises";
import { apiService } from "../../../../tests/support/cli-build.js";
import {
  benchChanges,
  compareContextPolicies,
  compareKnowledge,
  formatBench,
  parseContextPolicies,
  summariseBench,
  type BenchCaseResult,
  type BenchReport,
} from "./bench.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const read = (path: string) => readFile(new URL(`../../../../${path}`, import.meta.url), "utf8");
const code = async (id: string): Promise<Turn> => ({
  text: "```ts\n" + (await read(`fixtures/specs/demo-1/${id}.spec.ts`)) + "```",
});

describe("qajitsu bench (REQ-LLM-06)", () => {
  it("REQ-LLM-06/AC1 + AC2: runs seeded-bug and clean cases end to end and reports the rates", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    await writeFile(
      join(p.project, ".qa", "bench.yaml"),
      [
        "version: 1",
        "cases:",
        "  - { id: bench-cart-rounding, ticket: DEMO-1, flags: [BUG_CART_TOTAL_ROUNDING], expect: { detects: BUG-01, criterion: AC1 } }",
        "  - { id: bench-clean-cart, ticket: DEMO-1, flags: [], expect: { all_passed: true } }",
      ].join("\n"),
    );
    const analysis = JSON.stringify({
      summary: "Cart API.",
      change_type: ["api"],
      endpoints: [{ method: "GET", path: "/cart", source: [{ kind: "ac", id: "AC1" }] }],
      confidence: "high",
    });
    const draft = await read("fixtures/plans/demo-1-draft.json");
    const perCase = [{ text: analysis }, { text: draft }, await code("TC-01"), await code("TC-02")];
    const result = await p.run(["bench", "--model", "mock/scripted"], [...perCase, ...perCase]);
    expect(result.err).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain(
      "| bench-cart-rounding | DEMO-1 | BUG_CART_TOTAL_ROUNDING | accepted | TC-01 FAILED, TC-02 PASSED | detected |",
    );
    expect(result.out).toContain(
      "| bench-clean-cart | DEMO-1 | – | accepted | TC-01 PASSED, TC-02 PASSED | clean |",
    );
    expect(result.out).toContain("Detection 100% · false FAILED 0% · BLOCKED 0% · plan acceptance 100%");
    // REQ-LLM-14/AC4: ground truth (the plan covers the bug's criterion) and the agent scorecard.
    expect(result.out).toContain("Plans covering the bug's criterion 100%");
    expect(result.out).toContain("| Role | Model | Calls | p95 | Steps without repair | Guard denials |");
    expect(result.out).toMatch(/\| planner \| mock\/scripted \| 2 \|/);
    expect(result.out).toMatch(
      /Author right on the first try 100% · planner 0\.0 flags and 0\.0 coverage gaps per plan/,
    );
    const [file] = await readdir(join(p.home, ".qajitsu", "projects", "demo", "exports", "bench-results"));
    const report = JSON.parse(
      await readFile(
        join(p.home, ".qajitsu", "projects", "demo", "exports", "bench-results", file ?? ""),
        "utf8",
      ),
    ) as BenchReport;
    expect(report).toMatchObject({
      model: "mock/scripted",
      role: "all",
      summary: { detectionRate: 1, falseFailedRate: 0 },
    });
    expect(report.summary.tokens).toBeGreaterThan(0);
    // Benchmark runs are marked, approved as bench:<user> and never published.
    const publish = await p.run(["publish", "DEMO-1"]);
    expect(publish.exitCode).toBe(3);
    expect(publish.err).toContain("BENCH_RUN_NOT_PUBLISHABLE");
    const runs = join(p.home, "runs", "DEMO-1");
    const latest = (JSON.parse(await readFile(join(runs, "index.json"), "utf8")) as { latest: string })
      .latest;
    const record = await readFile(join(runs, latest, "run.json"), "utf8");
    expect(record).toContain('"bench"');
    expect(record).toContain('"approver": "bench:qa-lead"');
  }, 300_000);

  it("REQ-LLM-06: invalid case files and projects without build are configuration errors", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    await writeFile(join(p.project, ".qa", "bench.yaml"), "version: 1\ncases: []\n");
    expect((await p.run(["bench", "--model", "mock/scripted"])).err).toContain("BENCH_CASES_INVALID");
    expect((await p.run(["bench", "--model", "mock/scripted", "--cases", "missing.yaml"])).exitCode).toBe(3);
  });

  it("REQ-LLM-06/AC2: summary counts misses, false FAILED, BLOCKED, errors and cost", () => {
    const base = { flags: [], planAccepted: true, falseFailed: 0, blocked: 0, durationMs: 1000, tokens: 10 };
    const cases: BenchCaseResult[] = [
      {
        ...base,
        id: "a",
        ticket: "DEMO-1",
        expect: "detect",
        statuses: { "TC-01": "PASSED" },
        detected: false,
        costUsd: 0.01,
      },
      {
        ...base,
        id: "b",
        ticket: "DEMO-1",
        expect: "all_passed",
        statuses: { "TC-01": "FAILED", "TC-02": "BLOCKED" },
        falseFailed: 1,
        blocked: 1,
        costUsd: 0.02,
      },
      {
        ...base,
        id: "c",
        ticket: "DEMO-2",
        expect: "detect",
        statuses: {},
        planAccepted: false,
        error: "plan rejected",
      },
    ];
    const summary = summariseBench(cases);
    expect(summary).toEqual({
      detectionRate: 0,
      falseFailedRate: 1,
      blockedRate: 0.333,
      planAcceptanceRate: 0.667,
      durationMs: 3000,
      tokens: 30,
      costUsd: 0.03,
    });
    const text = formatBench({ model: "m/x", role: "author", at: "2026-10-04T00:00:00Z", cases, summary });
    expect(text).toContain("| a | DEMO-1 | – | accepted | TC-01 PASSED | missed |");
    expect(text).toContain("| b | DEMO-1 | – | accepted | TC-01 FAILED, TC-02 BLOCKED | 1 false FAILED |");
    expect(text).toContain("| c | DEMO-2 | – | rejected | – | error: plan rejected |");
    expect(text).toContain("$0.0300");
    expect(summariseBench([])).toEqual({
      detectionRate: 0,
      falseFailedRate: 0,
      blockedRate: 0,
      planAcceptanceRate: 0,
      durationMs: 0,
      tokens: 0,
    });
  });

  it("REQ-KNOW-11/AC1: --knowledge compare runs every case without and with the knowledge base and reports the difference", async () => {
    const embedder = createFakeEmbedder();
    const p = await createBuildProject(apiService(), {
      ports: { embedder: (ref) => Promise.resolve({ ...embedder, id: ref }) },
    });
    cleanups.push(p.cleanup);
    await writeFile(
      join(p.project, ".qa", "bench.yaml"),
      "version: 1\ncases:\n  - { id: bench-cart-rounding, ticket: DEMO-1, flags: [BUG_CART_TOTAL_ROUNDING], expect: { detects: BUG-01 } }\n",
    );
    expect((await p.run(["bench", "--model", "mock/scripted", "--knowledge", "compare"])).err).toContain(
      "[KNOWLEDGE_EMPTY]",
    );
    await mkdir(join(p.project, "docs"));
    await writeFile(
      join(p.project, "docs", "cart.md"),
      "# Cart\nThe cart total is rounded once, after summing the lines.\n",
    );
    expect((await p.run(["knowledge", "add", "docs"])).exitCode).toBe(0);
    const analysis = JSON.stringify({
      summary: "Cart API.",
      change_type: ["api"],
      endpoints: [{ method: "GET", path: "/cart", source: [{ kind: "ac", id: "AC1" }] }],
      confidence: "high",
    });
    const draft = await read("fixtures/plans/demo-1-draft.json");
    // Without documentation the scripted planner misses the rounding case; with it, it plans it.
    const weak = JSON.parse(draft) as { cases: { id: string }[] };
    weak.cases = weak.cases.filter((c) => c.id !== "TC-01");
    const result = await p.run(
      ["bench", "--model", "mock/scripted", "--knowledge", "compare"],
      [
        { text: analysis },
        { text: JSON.stringify(weak) },
        await code("TC-02"),
        { text: analysis },
        { text: draft },
        await code("TC-01"),
        await code("TC-02"),
      ],
    );
    expect(result.err).toBe("");
    expect(result.out).toContain(
      "bench-cart-rounding: DEMO-1 with BUG_CART_TOTAL_ROUNDING (without knowledge base)…",
    );
    expect(result.out).toContain(
      "| bench-cart-rounding (no docs) | DEMO-1 | BUG_CART_TOTAL_ROUNDING | accepted | TC-02 PASSED | missed |",
    );
    expect(result.out).toContain(
      "| bench-cart-rounding (docs) | DEMO-1 | BUG_CART_TOTAL_ROUNDING | accepted | TC-01 FAILED, TC-02 PASSED | detected |",
    );
    expect(result.out).toContain("| Detection | 0% | 100% | +100 pp |");
    expect(result.out).toContain("| False FAILED | 0% | 0% | 0 pp |");
    expect(result.out).toContain("| Plan accepted without edits | 100% | 100% | 0 pp |");
    // The first pass never saw the documentation; the second did.
    expect(promptOf(result.model, 0)).not.toContain("## Project documentation");
    expect(promptOf(result.model, 3)).toContain("## Project documentation");
    const dir = join(p.home, ".qajitsu", "projects", "demo", "exports", "bench-results");
    const report = JSON.parse(
      await readFile(join(dir, (await readdir(dir))[0] ?? ""), "utf8"),
    ) as BenchReport;
    expect(report).toMatchObject({ knowledge: "compare", comparison: { delta: { detectionRate: 1 } } });
    expect((await p.run(["bench", "--model", "mock/scripted", "--knowledge", "maybe"])).err).toContain(
      "[BENCH_KNOWLEDGE_INVALID]",
    );
  }, 300_000);

  it("REQ-KNOW-11/AC1: the comparison subtracts the pass without documentation from the pass with it", () => {
    const base = {
      ticket: "DEMO-1",
      flags: [],
      falseFailed: 0,
      blocked: 0,
      durationMs: 1,
      tokens: 1,
      statuses: {},
    };
    const c = compareKnowledge([
      { ...base, id: "a", expect: "detect", detected: false, planAccepted: false, knowledge: false },
      { ...base, id: "b", expect: "all_passed", falseFailed: 1, planAccepted: true, knowledge: false },
      { ...base, id: "a", expect: "detect", detected: true, planAccepted: true, knowledge: true },
      { ...base, id: "b", expect: "all_passed", planAccepted: true, knowledge: true },
    ]);
    expect(c.delta).toEqual({
      detectionRate: 1,
      falseFailedRate: -1,
      blockedRate: 0,
      planAcceptanceRate: 0.5,
    });
  });

  it("REQ-LLM-14/AC4: a benchmark is compared with the previous one of the same model", () => {
    const summary = {
      detectionRate: 0.5,
      falseFailedRate: 0.2,
      blockedRate: 0.1,
      planAcceptanceRate: 0.5,
      durationMs: 1,
      tokens: 1,
    };
    const card = (firstTry: number, flags: number) => ({
      roles: [],
      author: {
        cases: 1,
        firstTryShare: firstTry,
        failed: 0,
        findings: {},
        rules: {},
        reviewAccepted: 0,
        reviewSentBack: 0,
      },
      planner: { plans: 1, averageFlags: flags, averageGaps: 1 },
      healer: { heals: 0, acceptedShare: 0 },
    });
    const before: BenchReport = {
      model: "m/a",
      role: "all",
      at: "2026-10-01T00:00:00Z",
      cases: [],
      summary: { ...summary, criterionCoverageRate: 0.5 },
      scorecard: card(0.5, 2),
    };
    const after: BenchReport = {
      ...before,
      at: "2026-10-22T00:00:00Z",
      summary: { ...summary, detectionRate: 1, criterionCoverageRate: 1 },
      scorecard: card(0.75, 1),
    };
    const changes = benchChanges(before, after);
    expect(changes).toEqual({
      previousAt: "2026-10-01T00:00:00Z",
      detectionRate: 0.5,
      falseFailedRate: 0,
      blockedRate: 0,
      planAcceptanceRate: 0,
      criterionCoverageRate: 0.5,
      authorFirstTryShare: 0.25,
      plannerAverageFlags: -1,
      plannerAverageGaps: 0,
    });
    expect(formatBench({ ...after, sincePrevious: changes })).toContain(
      "Since 2026-10-01: detection +50 pp · false FAILED 0 pp · BLOCKED 0 pp · plan acceptance 0 pp · criterion coverage +50 pp · author first try +25 pp · planner flags -1.0 · coverage gaps +0.0",
    );
    // Reports without a scorecard (older ones) compare on what they have.
    const older: BenchReport = {
      model: before.model,
      role: before.role,
      at: before.at,
      cases: [],
      summary: before.summary,
    };
    expect(benchChanges(older, after).authorFirstTryShare).toBeUndefined();
  });

  it("REQ-CTX-18/AC2: --context runs every case once per policy and names the cheapest one at the best quality", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    await writeFile(
      join(p.project, ".qa", "bench.yaml"),
      "version: 1\ncases:\n  - { id: bench-cart-rounding, ticket: DEMO-1, flags: [BUG_CART_TOTAL_ROUNDING], expect: { detects: BUG-01 } }\n",
    );
    const analysis = JSON.stringify({
      summary: "Cart API.",
      change_type: ["api"],
      endpoints: [{ method: "GET", path: "/cart", source: [{ kind: "ac", id: "AC1" }] }],
      confidence: "high",
    });
    const draft = await read("fixtures/plans/demo-1-draft.json");
    const perCase = [{ text: analysis }, { text: draft }, await code("TC-01"), await code("TC-02")];
    const result = await p.run(
      ["bench", "--model", "mock/scripted", "--context", "default,compact+range=16000"],
      [...perCase, ...perCase],
    );
    expect(result.err).toBe("");
    expect(result.out).toContain(
      "bench-cart-rounding: DEMO-1 with BUG_CART_TOTAL_ROUNDING (context default)…",
    );
    expect(result.out).toContain("(context compact+range=16000)…");
    expect(result.out).toContain(
      "| Policy | Detection | False FAILED | Plan accepted | Criterion covered | Tokens | Cost | Time |",
    );
    // A tie in cost keeps the first policy.
    expect(result.out).toContain("| default (cheapest at best quality) | 100% | 0% | 100% |");
    expect(result.out).toContain("| compact+range=16000 | 100% | 0% | 100% |");
    // The policy reaches every call: the second pass's snapshots carry its budget and style.
    const runs = join(p.home, "runs", "DEMO-1");
    const latest = (JSON.parse(await readFile(join(runs, "index.json"), "utf8")) as { latest: string })
      .latest;
    const journal = await readFile(join(runs, latest, "journal", "events.jsonl"), "utf8");
    const budgets = journal
      .split("\n")
      .filter((l) => l.includes('"context.snapshot"'))
      .map(
        (l) => (JSON.parse(l) as { details: { budget?: { style: string; tokens: number } } }).details.budget,
      );
    expect(budgets.length).toBeGreaterThan(0);
    expect(budgets.every((b) => b?.style === "compact" && b.tokens <= 16_000)).toBe(true);
    expect((await p.run(["bench", "--model", "mock/scripted", "--context", "tiny"])).err).toContain(
      "[BENCH_CONTEXT_INVALID]",
    );
  });

  it("REQ-CTX-18/AC2: policies parse strictly; the cheapest policy that keeps the best quality is named", () => {
    expect(parseContextPolicies("default, compact+range=16000,full")).toEqual([
      { name: "default" },
      { name: "compact+range=16000", style: "compact", workingRange: 16_000 },
      { name: "full", style: "full" },
    ]);
    expect(() => parseContextPolicies("range=10")).toThrow(/range=<tokens of at least 1000>/);
    expect(() => parseContextPolicies("compact,compact")).toThrow(/repeated/);
    const c = (context: string, detected: boolean, tokens: number): BenchCaseResult => ({
      id: "b",
      ticket: "DEMO-1",
      flags: ["F"],
      expect: "detect",
      planAccepted: true,
      statuses: { "TC-01": detected ? "FAILED" : "PASSED" },
      detected,
      falseFailed: 0,
      blocked: 0,
      durationMs: 1_000,
      tokens,
      context,
    });
    const compared = compareContextPolicies([
      c("default", true, 9_000),
      c("compact", true, 4_000),
      c("range=8000", false, 2_000),
    ]);
    expect(compared.policies.map((x) => `${x.policy} ${String(x.summary.detectionRate)}`)).toEqual([
      "default 1",
      "compact 1",
      "range=8000 0",
    ]);
    // The cheapest policy misses the bug, so the cheapest one that keeps quality is compact.
    expect(compared.cheapest).toBe("compact");
  });
});
