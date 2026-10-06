import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildProject } from "../../../../tests/support/cli-build.js";
import { createFakeEmbedder } from "../../../../tests/support/fake-embedder.js";
import { promptOf, type Turn } from "../../../../tests/support/mock-model.js";
import { mkdir } from "node:fs/promises";
import { apiService } from "../../../../tests/support/cli-build.js";
import {
  compareKnowledge,
  formatBench,
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
        "  - { id: bench-cart-rounding, ticket: DEMO-1, flags: [BUG_CART_TOTAL_ROUNDING], expect: { detects: BUG-01 } }",
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
});
