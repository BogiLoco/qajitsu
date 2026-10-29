import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TicketKeySchema,
  collectLessons,
  createEventLog,
  createRunWorkspace,
  fragment,
  type ContextFragment,
} from "@qajitsu/core";
import { contextProfile } from "@qajitsu/models";
import { describe, expect, it } from "vitest";
import { createFakeEmbedder } from "../../../tests/support/fake-embedder.js";
import { changeGroups, splitChange } from "./change-split.js";
import { changeContextFragments, type ChangeContext } from "./context.js";
import { createSemanticIndex, joinBySimilarity, sameShape, shapeOf } from "./context-semantic.js";
import { assembleFor, type AgentStageDeps } from "./roles-run.js";

const f = (over: Partial<Parameters<typeof fragment>[0]> & { text: string }): ContextFragment =>
  fragment({
    kind: "repository",
    source: "x",
    trust: "untrusted",
    section: "varying",
    priority: 50,
    pinned: false,
    ...over,
  });

const role = f({
  kind: "role-instructions",
  source: "planner",
  trust: "trusted",
  section: "stable",
  priority: 100,
  pinned: true,
  text: "Plan.",
});
// Anchor terms need four letters; the fake embedder also matches short words like "fee" and "vat".
const ticket = f({
  kind: "ticket",
  source: "ticket/DEMO-1",
  priority: 85,
  text: "Show fee and vat on the bill",
});
const ask = f({
  kind: "question",
  source: "question",
  trust: "trusted",
  priority: 0,
  pinned: true,
  text: "Plan.",
});

const depsWith = (semantic?: AgentStageDeps["semantic"]) => {
  const lines: string[] = [];
  const events = createEventLog({
    ticket: "DEMO-1",
    run: "r",
    write: (l) => lines.push(l),
    now: () => new Date(0),
    mask: (v) => v,
  });
  const deps = { events, ...(semantic ? { semantic } : {}) } as unknown as AgentStageDeps;
  return { deps, lines };
};

/** A compact model: what matches nothing of the task waits behind a handle. */
const compact = {
  id: "m",
  context: { ...contextProfile("ollama", { contextWindow: 200_000 }), style: "compact" as const },
};

describe("semantic signals for choosing context (REQ-CTX-20)", () => {
  const related = f({ source: "repos/shop/pricing.ts", text: "fee vat tax" });
  const unrelated = f({ source: "repos/shop/zzz.ts", text: "qux zap" });

  it("REQ-CTX-20/AC1+AC6: similarity is a second signal; a fragment ranked low only waits behind a handle", async () => {
    const embedder = createFakeEmbedder({ dimensions: 1024 });
    const { deps } = depsWith(createSemanticIndex(embedder, { version: "1" }));
    const out = await assembleFor(deps, {
      stage: "plan",
      role: "planner",
      model: compact,
      fragments: [role, ticket, related, unrelated, ask],
    });
    expect(out.snapshot.embedding).toEqual({ model: "fake/embed", version: "1" });
    const ranked = new Map(out.snapshot.ranking.map((r) => [r.sha256, r]));
    expect(ranked.get(related.sha256)?.score).toBe(0);
    expect(ranked.get(related.sha256)?.semantic).toBeGreaterThan(ranked.get(unrelated.sha256)?.semantic ?? 1);
    expect(out.prompt).toContain("fee vat tax");
    expect(out.snapshot.catalogue.map((c) => c.source)).toEqual(["repos/shop/zzz.ts"]);
    // AC6: vectors are cached by hash and model: the same call embeds nothing again.
    const calls = embedder.calls.length;
    await assembleFor(deps, {
      stage: "plan",
      role: "planner",
      model: compact,
      fragments: [role, ticket, related, unrelated, ask],
    });
    expect(embedder.calls.length).toBe(calls);
  });

  it("REQ-CTX-20/AC6: without an embedding model, or when it fails, the code's signals alone decide", async () => {
    const without = await assembleFor(depsWith().deps, {
      stage: "plan",
      role: "planner",
      model: compact,
      fragments: [role, ticket, related, unrelated, ask],
    });
    expect(without.snapshot.embedding).toBeUndefined();
    expect(without.snapshot.ranking.every((r) => r.semantic === undefined)).toBe(true);
    expect(without.snapshot.catalogue.map((c) => c.source)).toEqual([
      "repos/shop/pricing.ts",
      "repos/shop/zzz.ts",
    ]);
    const broken = createSemanticIndex({
      id: "down/embed",
      local: true,
      embed: () => Promise.reject(new Error("connection refused")),
    });
    const { deps, lines } = depsWith(broken);
    const out = await assembleFor(deps, {
      stage: "plan",
      role: "planner",
      model: compact,
      fragments: [role, ticket, related, unrelated, ask],
    });
    expect(out.snapshot.catalogue).toEqual(without.snapshot.catalogue);
    expect(lines.map((l) => (JSON.parse(l) as { event: string }).event)).toEqual([
      "context.semantic_unavailable",
      "context.snapshot",
    ]);
  });

  it("REQ-CTX-20/AC2: search_context finds handles by meaning where the words do not match; results are data", async () => {
    const { deps, lines } = depsWith(createSemanticIndex(createFakeEmbedder()));
    const shelved = f({
      source: "logs/api.log",
      kind: "repository",
      onDemand: true,
      text: "fee vat bill bad",
    });
    const out = await assembleFor(deps, {
      stage: "plan",
      role: "planner",
      model: { id: "m" },
      fragments: [role, ticket, shelved, ask],
    });
    const search = out.tools?.find((t) => t.name === "search_context");
    const answer = String(await search?.execute({ question: "vat fee" }));
    expect(answer).toContain(out.snapshot.catalogue[0]?.handle ?? "none");
    expect(answer).toMatch(/^<data-[a-z0-9]{12} kind="tool-result" source="search_context">/);
    const last = JSON.parse(lines.at(-1) ?? "{}") as { event: string; details: { semantic: number } };
    expect(last.event).toBe("context.search");
    expect(last.details.semantic).toBe(1);
  });

  it("REQ-CTX-20/AC3: near-identical fragments are kept once when code confirms their text; the others wait", async () => {
    const log = (n: number, at: string) =>
      f({
        kind: "repository",
        source: `attempt-${String(n)}.log`,
        text: `${at} POST /cart/discount 500\nError: discount service timed out after ${String(n * 1000)} ms\nretry ${String(n)}`,
      });
    const first = log(1, "2026-10-29T10:00:00Z");
    const second = log(2, "2026-10-29T10:05:00Z");
    expect(sameShape(first.text, second.text)).toBe(true);
    expect(shapeOf("id 9f8e7d6c5b at 12")).toBe("id <id> at <n>");
    // Similar by meaning, but code finds different text: both stay.
    const other = f({
      kind: "repository",
      source: "notes.txt",
      text: "POST cart discount error service timed out retry",
    });
    const { deps } = depsWith(createSemanticIndex(createFakeEmbedder()));
    const out = await assembleFor(deps, {
      stage: "plan",
      role: "planner",
      model: { id: "m" },
      fragments: [role, ticket, first, second, other, ask],
    });
    expect(out.snapshot.reductions).toEqual([
      expect.objectContaining({
        sha256: second.sha256,
        action: "deduplicated",
        reason: expect.stringContaining("near-identical to attempt-1.log") as unknown,
      }),
    ]);
    expect(out.snapshot.catalogue.map((c) => c.source)).toEqual(["attempt-2.log"]);
    expect(out.prompt).toContain("notes.txt");
  });

  it("REQ-CTX-20/AC4: a lone file the code's links did not connect joins the group it resembles", async () => {
    const diff = (path: string, words: string) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,3 @@\n+${words}\n+${words}\n+${words}\n`;
    const repo = {
      alias: "shop",
      diff: [
        diff("src/cart/total.ts", "cart total discount rounding"),
        diff("src/cart/total.test.ts", "cart total discount rounding test"),
        diff("src/pricing/discount.ts", "cart total discount rounding"),
        diff("src/users/login.ts", "user login password session cookie"),
      ].join(""),
    };
    const context = { repos: [repo] } as unknown as ChangeContext;
    expect(changeGroups(context).map((g) => `${g.key}:${String(g.files)}`)).toEqual([
      "shop:cart:2",
      "shop:pricing:1",
      "shop:users:1",
    ]);
    const joined = await joinBySimilarity(createSemanticIndex(createFakeEmbedder()), changeGroups(context));
    expect([...joined]).toEqual([["shop:pricing", "shop:cart"]]);
    const parts = splitChange(
      { ...context, repos: [{ ...repo, files: [], diffInlined: true }] } as unknown as ChangeContext,
      200,
      joined,
    );
    expect(parts.parts.map((p) => p.part.files)).toEqual([
      ["src/cart/total.test.ts", "src/cart/total.ts", "src/pricing/discount.ts"],
      ["src/users/login.ts"],
    ]);
  });

  it("REQ-CTX-20/AC5: lessons of earlier runs reach the analyst and planner as low-priority, labelled fragments", async () => {
    const root = await mkdtemp(join(tmpdir(), "qj-lessons-"));
    try {
      const earlier = await createRunWorkspace({
        root,
        ticket: TicketKeySchema.parse("DEMO-2"),
        now: () => new Date("2026-10-01T10:00:00Z"),
        random: () => 0,
      });
      await earlier.update({
        data: {
          feedback: {
            cases: {
              C02: {
                is: "test-bug",
                by: "anna",
                at: "2026-10-02T10:00:00Z",
                note: "the total is in PLN, not EUR",
              },
              C03: { is: "product-bug", by: "anna", at: "2026-10-02T10:00:00Z" },
            },
            escaped: [{ bug: "DEMO-9", by: "piotr", at: "2026-10-05T10:00:00Z" }],
          },
        },
      });
      const journal: string[] = [];
      createEventLog({
        ticket: TicketKeySchema.parse("DEMO-2"),
        run: earlier.runId,
        write: (l) => journal.push(l),
        now: () => new Date("2026-10-01T11:00:00Z"),
        mask: (v) => v,
      }).emit("plan", { kind: "user", name: "anna" }, "plan.revision_requested", {
        instruction: "Check the discount with two codes too",
      });
      await writeFile(earlier.path("journal", "events.jsonl"), journal.join(""));
      const current = await createRunWorkspace({
        root,
        ticket: TicketKeySchema.parse("DEMO-1"),
        now: () => new Date("2026-10-10T10:00:00Z"),
        random: () => 0.5,
      });
      const lessons = await collectLessons(root, { exclude: current.runId });
      expect(lessons.map((l) => `${l.kind} ${l.at}`)).toEqual([
        "escaped 2026-10-05T10:00:00Z",
        "false-failed 2026-10-02T10:00:00Z",
        "revision 2026-10-01T11:00:00.000Z",
      ]);
      expect(lessons[1]?.text).toContain("test-bug problem, not a product bug: the total is in PLN, not EUR");
      const context = {
        ticket: {
          key: "DEMO-1",
          summary: "s",
          issueType: "Story",
          status: "s",
          description: "",
          acceptanceCriteria: [],
          comments: [],
        },
        repos: [],
        knowledge: [],
        testsRepos: [],
        docs: new Map(),
        explorations: [],
        imported: [],
        lessons,
      } as unknown as ChangeContext;
      const offered = changeContextFragments(context, { lessons: true }).filter((x) => x.kind === "lesson");
      expect(offered.map((x) => `${x.source} ${x.trust} ${String(x.priority)}`)).toEqual([
        "lessons trusted 30",
        `lesson/DEMO-2/${earlier.runId}/escaped untrusted 30`,
        `lesson/DEMO-2/${earlier.runId}/false-failed untrusted 30`,
        `lesson/DEMO-2/${earlier.runId}/revision untrusted 30`,
      ]);
      // Other roles (the approver, the explorer) are not offered lessons.
      expect(changeContextFragments(context).some((x) => x.kind === "lesson")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
