import { readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createEventLog, parseEventLines, type Analysis, type RunWorkspace } from "@qajitsu/core";
import type { ResolvedModel } from "@qajitsu/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promptOf, scriptedModel } from "../../../tests/support/mock-model.js";
import { createFetchedRun } from "../../../tests/support/run-fixture.js";
import { changeFits, mergeAnalyses, moduleOf, splitChange } from "./change-split.js";
import { buildChangeContext } from "./context.js";
import { runAnalyst, runPlanner, type AgentStageDeps } from "./roles-run.js";
import { createUsageTracker } from "./usage.js";

/** A diff of one file with `n` added lines of about 50 characters. */
const fileDiff = (path: string, n: number): string =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,1 +1,${String(n)} @@`,
    ...Array.from(
      { length: n },
      (_, i) => `+export const line${String(i)} = ${String(i)}; // padding padding`,
    ),
    "",
  ].join("\n");

const DIFF = [
  fileDiff("src/orders/create.ts", 60),
  fileDiff("src/cart/total.ts", 60),
  fileDiff("tests/cart/total.test.ts", 60),
  fileDiff("src/orders/__tests__/create.spec.ts", 60),
].join("");

const analysisOf = (over: Partial<Analysis>): Analysis => ({
  summary: "part",
  change_type: ["api"],
  endpoints: [],
  screens: [],
  risks: [],
  confidence: "high",
  open_questions: [],
  ...over,
});

describe("large changes analysed in parts (REQ-CTX-19)", () => {
  it("REQ-CTX-19/AC1: groups a module with its tests, per repository, and packs groups up to the budget", () => {
    expect(moduleOf("src/cart/total.ts")).toBe("cart");
    expect(moduleOf("tests/cart/total.test.ts")).toBe("cart");
    expect(moduleOf("src/orders/__tests__/create.spec.ts")).toBe("orders");
    expect(moduleOf("README.md")).toBe(".");
  });

  describe("on a fetched run", () => {
    let root: string;
    let ws: RunWorkspace;
    let lines: string[];
    beforeEach(async () => {
      ({ root, ws } = await createFetchedRun({ diff: DIFF }));
      lines = [];
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const deps = (models: { analyst: ResolvedModel; planner?: ResolvedModel }): AgentStageDeps => {
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
            Promise.resolve(role === "planner" ? (models.planner ?? models.analyst) : models.analyst),
          resolve: () => Promise.reject(new Error("unused")),
        },
        events,
        usage: createUsageTracker({ events }),
        now: () => new Date(0),
        maskJson: (v) => v,
        maskText: (t) => t,
      };
    };

    /** A model whose good working range is 6k tokens: a 4k budget, of which the change's diffs may take 2k. */
    const small = (turns: Parameters<typeof scriptedModel>[0]): ReturnType<typeof scriptedModel> => {
      const m = scriptedModel(turns);
      return { ...m, context: { ...m.context, workingRange: 6_000, answerReserve: 2_000 } };
    };

    it("REQ-CTX-19/AC1+AC4: splits the same change the same way, every part fits its budget", async () => {
      const context = await buildChangeContext(ws);
      expect(changeFits(context, 2_000)).toBe(false);
      expect(changeFits(context, 4_000)).toBe(true);
      const a = splitChange(context, 2_000);
      const b = splitChange(await buildChangeContext(ws), 2_000);
      expect(a.parts.map((p) => p.part)).toEqual(b.parts.map((p) => p.part));
      expect(a.parts.map((p) => p.part.files)).toEqual([
        ["src/cart/total.ts", "tests/cart/total.test.ts"],
        ["src/orders/__tests__/create.spec.ts", "src/orders/create.ts"],
      ]);
      for (const { part, context: c } of a.parts) {
        expect(part.tokens).toBeLessThanOrEqual(2_000);
        expect(c.repos).toHaveLength(1);
        expect(c.repos[0]?.files.map((f) => f.path)).toEqual(part.files);
        expect(c.repos[0]?.diffInlined).toBe(true);
      }
      // A group larger than the budget is split per file.
      expect(splitChange(context, 900).parts.map((p) => p.part.files.length)).toEqual([1, 1, 1, 1]);
    });

    it("REQ-CTX-19/AC1+AC2+AC4: the analyst studies each part in its own call; code merges and records the parts", async () => {
      const analyst = small([
        {
          text: JSON.stringify(
            analysisOf({
              summary: "Cart total.",
              endpoints: [{ method: "GET", path: "/cart", source: [{ kind: "ac", id: "AC1" }] }],
              risks: [{ description: "Rounding per line", source: [{ kind: "ac", id: "AC1" }] }],
            }),
          ),
        },
        {
          text: JSON.stringify(
            analysisOf({
              summary: "Orders.",
              confidence: "medium",
              endpoints: [
                { method: "get", path: "/cart", source: [{ kind: "ac", id: "AC2" }] },
                { method: "POST", path: "/cart/discount", source: [{ kind: "ac", id: "AC2" }] },
              ],
              risks: [{ description: "rounding  per line", source: [{ kind: "ac", id: "AC1" }] }],
              open_questions: [{ id: "Q1", question: "Do orders keep the discount?" }],
            }),
          ),
        },
      ]);
      const result = await runAnalyst(deps({ analyst }), await buildChangeContext(ws));
      expect(promptOf(analyst, 0)).toContain("part P1");
      expect(promptOf(analyst, 0)).toContain("src/cart/total.ts");
      expect(promptOf(analyst, 0)).not.toContain("src/orders/create.ts");
      expect(promptOf(analyst, 1)).toContain("src/orders/create.ts");
      expect(result.summary).toBe("P1: Cart total.\nP2: Orders.");
      expect(result.endpoints).toEqual([
        {
          method: "GET",
          path: "/cart",
          source: [
            { kind: "ac", id: "AC1" },
            { kind: "ac", id: "AC2" },
          ],
        },
        { method: "POST", path: "/cart/discount", source: [{ kind: "ac", id: "AC2" }] },
      ]);
      expect(result.risks).toHaveLength(1);
      expect(result.confidence).toBe("medium");
      expect(result.open_questions).toEqual([{ id: "Q1", question: "Do orders keep the discount?" }]);
      const events = parseEventLines(lines.join("")).events;
      expect(events.map((e) => e.event)).toEqual([
        "stage.start",
        "analyze.split",
        "context.snapshot",
        "model.usage",
        "analyze.part",
        "context.snapshot",
        "model.usage",
        "analyze.part",
        "stage.end",
      ]);
      const recorded = JSON.parse(await readFile(ws.path("analysis.parts.json"), "utf8")) as {
        parts: { id: string; snapshot: string; sha256: string }[];
      };
      expect(recorded.parts.map((p) => p.id)).toEqual(["P1", "P2"]);
      expect(recorded.parts.every((p) => /^[0-9a-f]{64}$/.test(p.snapshot))).toBe(true);
    });

    it("REQ-CTX-19/AC2: a part's claim that cites a source the change does not have is sent back", async () => {
      const bad = analysisOf({
        risks: [
          {
            description: "Invented",
            source: [{ kind: "quote", text: "Admins never pay for shipping at all" }],
          },
        ],
      });
      const analyst = small([{ text: JSON.stringify(bad) }, { text: JSON.stringify(analysisOf({})) }]);
      await runAnalyst(deps({ analyst }), await buildChangeContext(ws));
      expect(promptOf(analyst, 1)).toContain("not verbatim in the ticket snapshot");
    });

    it("REQ-CTX-19/AC3: the planner of a split change gets the diffs behind handles, not inline", async () => {
      const draft = readFileSync(
        new URL("../../../fixtures/plans/demo-1-draft.json", import.meta.url),
        "utf8",
      );
      const planner = small([{ text: draft }]);
      await runPlanner(deps({ analyst: planner, planner }), await buildChangeContext(ws), analysisOf({}));
      const snapshot = parseEventLines(lines.join("")).events.find((e) => e.event === "context.snapshot");
      const catalogue = (snapshot?.details as { catalogue: { source: string; kind: string }[] }).catalogue;
      expect(catalogue.filter((c) => c.kind === "diff").map((c) => c.source)).toEqual(["repos/shop/diff"]);
      expect(promptOf(planner, 0)).not.toContain("export const line0");
    });

    it("REQ-CTX-19/AC2: merging keeps the first wording, joins sources and renumbers questions", () => {
      const merged = mergeAnalyses([
        {
          id: "P1",
          analysis: analysisOf({
            screens: [{ name: "Cart", source: [{ kind: "ac", id: "AC1" }] }],
            open_questions: [{ id: "Q1", question: "Which currency?" }],
          }),
        },
        {
          id: "P2",
          analysis: analysisOf({
            change_type: ["web", "api"],
            confidence: "low",
            screens: [{ name: "cart", source: [{ kind: "ac", id: "AC1" }] }],
            open_questions: [
              { id: "Q1", question: "Which  currency?" },
              { id: "Q2", question: "Who pays shipping?" },
            ],
          }),
        },
      ]);
      expect(merged.change_type).toEqual(["api", "web"]);
      expect(merged.screens).toEqual([{ name: "Cart", source: [{ kind: "ac", id: "AC1" }] }]);
      expect(merged.confidence).toBe("low");
      expect(merged.open_questions.map((q) => `${q.id} ${q.question}`)).toEqual([
        "Q1 Which currency?",
        "Q2 Who pays shipping?",
      ]);
    });
  });
});
