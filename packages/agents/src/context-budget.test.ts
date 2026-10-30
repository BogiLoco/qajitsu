import { fragment } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { ContextTooLargeError, createContextManager, type ContextBudget } from "./context-manager.js";

const f = (over: Partial<Parameters<typeof fragment>[0]> & { text: string }) =>
  fragment({
    kind: "result",
    source: "x",
    trust: "untrusted",
    section: "varying",
    priority: 50,
    pinned: false,
    ...over,
  });
const budget = (tokens: number, style: "full" | "compact" = "full"): ContextBudget => ({
  tokens,
  margin: 1,
  counting: "estimate",
  style,
  profile: "test",
});
const instructions = f({
  kind: "role-instructions",
  source: "planner",
  trust: "trusted",
  section: "stable",
  priority: 100,
  pinned: true,
  text: "Plan tests.",
});
const ticket = f({
  kind: "ticket",
  source: "ticket/DEMO-1",
  priority: 85,
  text: "Discount codes apply to the cart total in checkout.ts",
});
const relevant = f({
  kind: "repository",
  source: "repos/shop/checkout.ts",
  priority: 70,
  text: "export function checkout(total) { /* discount */ }".repeat(20),
});
const unrelated = f({
  kind: "knowledge",
  source: "knowledge/holidays.md",
  priority: 40,
  text: "Office holidays and parking rules. ".repeat(60),
});
const bigDiff = f({
  kind: "diff",
  source: "repos/shop/diff",
  priority: 70,
  text: [
    "diff --git a/checkout.ts b/checkout.ts",
    "@@ -1,80 +1,80 @@ export function checkout(total)",
    ...Array.from({ length: 80 }, (_, i) =>
      i === 40
        ? "+  total = applyDiscount(total, code);"
        : `   const line${String(i)} = ${String(i)}; // unchanged`,
    ),
  ].join("\n"),
});
const question = f({
  kind: "question",
  source: "question",
  trust: "trusted",
  priority: 0,
  pinned: true,
  text: "Write the plan.",
});
const all = [instructions, ticket, relevant, unrelated, bigDiff, question];

describe("context budget and reductions (REQ-CTX-12, REQ-CTX-14, REQ-LLM-15/AC4)", () => {
  it("REQ-CTX-14/AC1: a call that fits is sent as it is: no reduction ahead of need", () => {
    const out = createContextManager({ marker: "testmarker00" }).assemble({
      stage: "plan",
      role: "t",
      model: "m",
      fragments: all,
      budget: budget(100_000),
    });
    expect(out.snapshot.reductions).toEqual([]);
    expect(out.snapshot.catalogue).toEqual([]);
    expect(out.prompt).toContain("Office holidays");
    expect(out.snapshot.budget).toMatchObject({ tokens: 100_000, margin: 1, style: "full", profile: "test" });
  });

  it("REQ-CTX-14/AC2 + REQ-CTX-12/AC3+AC4+AC6: over budget, what matches nothing goes behind a handle first, then the diff is trimmed with its structure; every reduction is recorded", () => {
    const cm = createContextManager({ marker: "testmarker00" });
    const out = cm.assemble({ stage: "plan", role: "t", model: "m", fragments: all, budget: budget(700) });
    expect(out.snapshot.reductions.map((r) => [r.action, r.reason])).toEqual([
      ["handle", "over budget: matches nothing of the task"],
      ["trimmed", "over budget: kept the structure of the diff"],
    ]);
    expect(out.prompt).not.toContain("Office holidays");
    expect(out.prompt).toContain("+  total = applyDiscount(total, code);");
    expect(out.prompt).toContain("@@ -1,80 +1,80 @@ export function checkout(total)");
    expect(out.prompt).not.toContain("line10 = 10");
    expect(out.prompt).toContain("## Catalogue: more context of this task, behind handles");
    // Both the shelved document and the full diff are readable by handle; the read is the full text, as data.
    const handles = out.snapshot.catalogue.map((c) => c.handle);
    expect(handles).toHaveLength(2);
    const diffHandle = out.snapshot.catalogue.find((c) => c.kind === "diff")?.handle ?? "";
    expect(cm.read(diffHandle)).toContain("line10 = 10");
    expect(cm.read(diffHandle)).toContain('<data-testmarker00 kind="diff"');
    expect(cm.read("h-00000000")).toBeUndefined();
    expect(cm.search("holidays parking")[0]?.source).toBe("knowledge/holidays.md");
    // AC6: the ranking with its reasons is in the snapshot.
    expect(out.snapshot.ranking.find((r) => r.sha256 === relevant.sha256)?.terms).toContain("checkout.ts");
    expect(out.snapshot.ranking.find((r) => r.sha256 === unrelated.sha256)?.score).toBe(0);
  });

  it("REQ-CTX-11/AC2 + REQ-CTX-14/AC3: pinned fragments are never reduced; when they alone do not fit, nothing is sent", () => {
    const plan = f({
      kind: "plan",
      source: "plan",
      trust: "trusted",
      pinned: true,
      text: "expected total 10.05 ".repeat(200),
    });
    const out = createContextManager({ marker: "testmarker00" }).assemble({
      stage: "plan",
      role: "t",
      model: "m",
      fragments: [instructions, plan, unrelated, question],
      // The pinned fragments and the catalogue line of what was put behind a handle.
      budget: budget(1_200),
    });
    expect(out.prompt).toContain("expected total 10.05");
    expect(out.snapshot.reductions.every((r) => r.sha256 !== plan.sha256)).toBe(true);
    expect(() =>
      createContextManager({ marker: "testmarker00" }).assemble({
        stage: "plan",
        role: "t",
        model: "m",
        fragments: [instructions, plan, question],
        budget: budget(100),
      }),
    ).toThrow(ContextTooLargeError);
  });

  it("REQ-CTX-12/AC5 + REQ-LLM-15/AC4: on-demand material and, for compact models, what matches nothing start behind handles", () => {
    const docs = f({
      kind: "knowledge",
      source: "docs/api.md#1",
      priority: 38,
      onDemand: true,
      text: "Discount rules for checkout totals.",
    });
    const full = createContextManager({ marker: "testmarker00" }).assemble({
      stage: "plan",
      role: "t",
      model: "m",
      fragments: [...all, docs],
      budget: budget(100_000),
    });
    expect(full.prompt).not.toContain("Discount rules for checkout totals.");
    expect(full.snapshot.catalogue.map((c) => c.source)).toEqual(["docs/api.md#1"]);
    expect(full.prompt).toContain("Office holidays");
    const compact = createContextManager({ marker: "testmarker00" }).assemble({
      stage: "plan",
      role: "t",
      model: "m",
      fragments: all,
      budget: budget(100_000, "compact"),
    });
    expect(compact.prompt).not.toContain("Office holidays");
    expect(compact.snapshot.reductions.map((r) => r.reason)).toEqual([
      "compact style: matches nothing of the task",
    ]);
    // A fragment smaller than its catalogue line stays: a heading behind a handle saves nothing (dogfood 2026-10-29).
    const heading = f({
      kind: "ticket",
      source: "ticket/heading",
      trust: "trusted",
      priority: 86,
      text: "## Ticket",
    });
    const kept = createContextManager({ marker: "testmarker00" }).assemble({
      stage: "plan",
      role: "t",
      model: "m",
      fragments: [...all, heading],
      budget: budget(100_000, "compact"),
    });
    expect(kept.prompt).toContain("## Ticket");
    expect(kept.snapshot.catalogue.map((c) => c.source)).not.toContain("ticket/heading");
  });

  it("REQ-CTX-14/AC2: duplicates are sent once", () => {
    const twice = f({ kind: "log", source: "logs/a.log", text: "ERROR same line" });
    const again = { ...twice, source: "logs/b.log" };
    const out = createContextManager({ marker: "testmarker00" }).assemble({
      stage: "t",
      role: "t",
      model: "m",
      fragments: [instructions, twice, again, question],
    });
    expect(out.prompt.split("ERROR same line")).toHaveLength(2);
    expect(out.snapshot.reductions.map((r) => r.action)).toEqual(["deduplicated"]);
  });

  describe("shares of the budget per source (REQ-CTX-14/AC1)", () => {
    const task = f({
      kind: "ticket",
      source: "ticket/DEMO-1",
      priority: 85,
      text: "Discount codes apply to the cart total",
    });
    const docs = f({
      kind: "knowledge",
      source: "docs/discounts.md",
      priority: 40,
      text: "discount rules for the cart ".repeat(70),
    });
    const change = f({
      kind: "diff",
      source: "repos/shop/diff",
      priority: 70,
      text: "discount codes cart total ".repeat(110),
    });
    const shared = (tokens: number, shares?: Record<string, number>): ContextBudget => ({
      ...budget(tokens),
      ...(shares ? { shares } : {}),
    });
    const assemble = (b: ContextBudget) =>
      createContextManager({ marker: "testmarker00" }).assemble({
        stage: "plan",
        role: "t",
        model: "m",
        fragments: [instructions, task, docs, change],
        budget: b,
      });

    it("REQ-CTX-14/AC1: a source over its share is reduced first, before a less relevant source within its share", () => {
      // Without shares the least relevant source (the documentation) waits behind a handle.
      expect(assemble(shared(1_000)).snapshot.catalogue.map((c) => c.source)).toEqual(["docs/discounts.md"]);
      // With the diff limited to 30% of the budget, the diff goes behind a handle and the documentation stays.
      const out = assemble(shared(1_000, { diff: 0.3 }));
      expect(out.snapshot.catalogue.map((c) => c.source)).toEqual(["repos/shop/diff"]);
      expect(out.prompt).toContain("discount rules for the cart");
      expect(out.snapshot.reductions.map((r) => r.reason)).toEqual([
        "over budget: diff over its share of 300 tokens: least relevant",
      ]);
      expect(out.snapshot.budget?.shares).toEqual({ diff: 0.3 });
    });

    it("REQ-CTX-14/AC1+AC4: a fragment trimmed for its share is not trimmed again when the whole call is still over", () => {
      const out = createContextManager({ marker: "testmarker00" }).assemble({
        stage: "plan",
        role: "t",
        model: "m",
        fragments: [instructions, task, docs, bigDiff],
        // The diff is trimmed for its share; the call is still over, so the general reductions follow.
        budget: shared(400, { diff: 0.5 }),
      });
      const shas = out.snapshot.reductions.map((r) => r.sha256);
      expect(new Set(shas).size).toBe(shas.length);
      expect(out.snapshot.reductions.find((r) => r.sha256 === bigDiff.sha256)?.reason).toBe(
        "over budget: diff over its share of 200 tokens: kept the structure of the diff",
      );
    });

    it("REQ-CTX-14/AC1: shares that are not used go to the others; a call that fits is sent whole", () => {
      // Both sources are far over their shares, but the whole call fits: nothing is reduced ahead of need.
      const out = assemble(shared(10_000, { diff: 0.05, knowledge: 0.05 }));
      expect(out.snapshot.reductions).toEqual([]);
      expect(out.snapshot.catalogue).toEqual([]);
      // Over the budget, only as much is reduced as the call needs: a source within its share is untouched.
      const tight = assemble(shared(1_000, { diff: 0.3, knowledge: 0.6 }));
      expect(tight.snapshot.catalogue.map((c) => c.source)).toEqual(["repos/shop/diff"]);
    });
  });

  it("REQ-CTX-14/AC2: the least relevant per token goes first; small fragments stay; the catalogue counts in the budget", () => {
    // The planner's input of DEMO-11 in the dogfood of 2026-10-30: a large page recording that names many terms of
    // the task, a smaller analysis that names fewer, an empty diff and a heading.
    const words = "notes offline queue saved count install manifest service worker sync";
    const pages = f({
      kind: "ui",
      source: "ui/snapshot",
      priority: 54,
      text: `${words} `.repeat(4) + "page row ".repeat(1_200),
    });
    const analysis = f({
      kind: "analysis",
      source: "analysis.json",
      priority: 30,
      text: `${words.split(" ").slice(0, 6).join(" ")} ${"x".repeat(1_500)}`,
    });
    const heading = f({
      kind: "ticket",
      source: "ticket/heading",
      trust: "trusted",
      priority: 86,
      text: "## Ticket",
    });
    const emptyDiff = f({ kind: "diff", source: "repos/shop/diff", priority: 70, text: "" });
    const task = f({
      kind: "ticket",
      source: "ticket/DEMO-11",
      priority: 85,
      text: `Offline notes: ${words}`,
    });
    const out = createContextManager({ marker: "testmarker00" }).assemble({
      stage: "plan",
      role: "t",
      model: "m",
      fragments: [instructions, heading, task, emptyDiff, analysis, pages, question],
      budget: budget(2_000),
    });
    expect(out.snapshot.catalogue.map((c) => c.source)).toEqual(["ui/snapshot"]);
    expect(out.prompt).toContain("analysis.json");
    expect(out.prompt).toContain("## Ticket");
    expect(out.snapshot.budget?.used).toBeLessThanOrEqual(2_000);
  });
});
