import { mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chunkId, parseEventLines } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { analysis, apiService, createBuildProject, draft } from "../../../../tests/support/cli-build.js";
import { createFakeEmbedder } from "../../../../tests/support/fake-embedder.js";
import { promptOf } from "../../../../tests/support/mock-model.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const ROUNDING =
  "# Cart\n## Rounding\nThe cart total is rounded once, after summing the unrounded line totals.\n";
const CHUNK = chunkId("docs/cart.md", 0);

/** The demo draft with a documentation source on TC-01. */
const draftCiting = (doc: Record<string, unknown>, chunk = CHUNK): string => {
  const plan = JSON.parse(draft) as { cases: { source: unknown[] }[] };
  plan.cases[0]?.source.push({ kind: "doc", chunk, ...doc });
  return JSON.stringify(plan);
};

const setup = async (config = "") => {
  const embedder = createFakeEmbedder();
  const p = await createBuildProject(apiService(), {
    ports: { embedder: (ref) => Promise.resolve({ ...embedder, id: ref }) },
  });
  cleanups.push(p.cleanup);
  const yaml = join(p.project, ".qa", "qa.project.yaml");
  if (config) await writeFile(yaml, `${await readFile(yaml, "utf8")}\n${config}\n`);
  await mkdir(join(p.project, "docs"));
  await writeFile(join(p.project, "docs", "cart.md"), ROUNDING);
  expect((await p.run(["knowledge", "add", "docs"])).exitCode).toBe(0);
  expect((await p.run(["fetch", "DEMO-1"])).exitCode).toBe(0);
  const runDir = async () => {
    const id =
      (await readdir(join(p.home, "runs", "DEMO-1")))
        .filter((f) => /^\d{8}-/.test(f))
        .sort()
        .at(-1) ?? "";
    return join(p.home, "runs", "DEMO-1", id);
  };
  return { ...p, embedder, runDir };
};

describe("documentation in planning (REQ-KNOW-06, REQ-KNOW-07, REQ-KNOW-10)", () => {
  it("REQ-KNOW-06/AC1+AC2+AC4+AC5 + REQ-KNOW-07/AC3: the planner searches, cites a chunk and the plan shows its source", async () => {
    const p = await setup("knowledge: { full_context_tokens: 5 }");
    const planned = await p.run(
      ["plan", "DEMO-1"],
      [
        { text: analysis },
        { tools: [{ name: "search_docs", input: { query: "cart total rounding" } }] },
        { text: draftCiting({ quote: "The cart total is rounded once" }) },
      ],
    );
    expect(planned.exitCode).toBe(0);
    // Hybrid mode: no documentation in the prompt, only the tool; its output is untrusted data with the source.
    expect(promptOf(planned.model, 1)).toContain("Use the search_docs tool");
    const toolResult = promptOf(planned.model, 2);
    expect(toolResult).toContain(`[chunk ${CHUNK}] docs/cart.md › Cart > Rounding (modified 20`);
    expect(toolResult).toContain('<untrusted_data source=\\"knowledge:docs/cart.md\\">');
    const dir = await p.runDir();
    const md = await readFile(join(dir, "plan", "plan.v1.md"), "utf8");
    expect(md).toMatch(
      /docs\/cart\.md › Cart > Rounding \(20\d\d-\d\d-\d\d\): "The cart total is rounded once"/,
    );
    expect(await readFile(join(dir, "plan", "plan.v1.yaml"), "utf8")).toContain("path: docs/cart.md");
    const events = parseEventLines(await readFile(join(dir, "journal", "events.jsonl"), "utf8"));
    expect(events.invalidLines).toEqual([]);
    expect(events.events.find((e) => e.event === "knowledge.search")).toMatchObject({
      stage: "plan",
      actor: { kind: "agent", name: "planner" },
      details: { query: "cart total rounding", chunks: [CHUNK] },
    });
    expect(
      Object.keys(JSON.parse(await readFile(join(dir, "knowledge", "chunks.json"), "utf8")) as object),
    ).toEqual([CHUNK]);
    // Approval re-checks the quote against the run's snapshot of the chunk.
    expect((await p.run(["approve", "DEMO-1"])).exitCode).toBe(0);
  }, 120_000);

  it("REQ-KNOW-06/AC3: a quote that is not verbatim in the chunk, or a chunk never retrieved, rejects the plan output", async () => {
    const p = await setup("knowledge: { full_context_tokens: 5 }");
    const wrong = draftCiting({ quote: "The cart total is rounded per line" });
    const planned = await p.run(
      ["plan", "DEMO-1"],
      [
        { text: analysis },
        { tools: [{ name: "search_docs", input: { query: "rounding" } }] },
        { text: wrong },
      ],
    );
    expect(planned.exitCode).toBe(3);
    expect(planned.err).toContain("the quote is not in docs/cart.md");
    // A chunk id the run's agents were never given (another file of the project).
    const unseen = await p.run(
      ["plan", "DEMO-1"],
      [{ text: draftCiting({ quote: "The cart total is rounded once" }, chunkId("docs/other.md", 0)) }],
    );
    expect(unseen.exitCode).toBe(3);
    expect(unseen.err).toContain("no such documentation chunk");
  }, 120_000);

  it("REQ-KNOW-07/AC1 + REQ-KNOW-10/AC1: small documentation is given in full, without embeddings; outdated files are marked", async () => {
    const p = await setup("knowledge: { max_age_days: 30 }");
    const old = new Date(Date.now() - 90 * 86_400_000);
    await utimes(join(p.project, "docs", "cart.md"), old, old);
    await writeFile(join(p.project, "docs", "cart.md"), ROUNDING.replace("once", "once only"));
    await utimes(join(p.project, "docs", "cart.md"), old, old);
    expect((await p.run(["knowledge", "sync"])).out).toContain("1 updated");
    const planned = await p.run(
      ["plan", "DEMO-1"],
      [{ text: analysis }, { text: draftCiting({ quote: "The cart total is rounded once only" }) }],
    );
    expect(planned.exitCode).toBe(0);
    expect(p.embedder.calls).toEqual([]);
    const analystPrompt = promptOf(planned.model, 0);
    expect(analystPrompt).toContain("## Project documentation (all of it");
    expect(analystPrompt).toContain("possibly outdated");
    expect(analystPrompt).toContain("rounded once only");
    const md = await readFile(join(await p.runDir(), "plan", "plan.v1.md"), "utf8");
    expect(md).toMatch(/docs\/cart\.md › Cart > Rounding \(\d{4}-\d\d-\d\d, possibly outdated\)/);
  }, 120_000);

  it("REQ-KNOW-04/AC3: with auto_sync the knowledge base is synced before planning", async () => {
    const p = await setup("knowledge: { auto_sync: true }");
    await writeFile(join(p.project, "docs", "cart.md"), ROUNDING.replace("once", "exactly once"));
    const planned = await p.run(
      ["plan", "DEMO-1"],
      [{ text: analysis }, { text: draftCiting({ quote: "The cart total is rounded exactly once" }) }],
    );
    expect(planned.out).toContain("Knowledge base synced: 0 added, 1 updated, 0 removed.");
    expect(planned.exitCode).toBe(0);
  }, 120_000);

  it("REQ-KNOW-10/AC2: the planner is told to ask instead of choosing when documentation contradicts the ticket", async () => {
    const p = await setup();
    const planned = await p.run(["plan", "DEMO-1"], [{ text: analysis }, { text: draft }]);
    expect(promptOf(planned.model, 1)).toContain(
      "When the documentation contradicts the ticket, do not choose one: add an open question that quotes both.",
    );
  }, 120_000);
});
