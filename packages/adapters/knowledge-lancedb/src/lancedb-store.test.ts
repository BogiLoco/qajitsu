import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@lancedb/lancedb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vectorStoreContract } from "../../../../tests/contract/vector-store.contract.js";
import { createFakeEmbedder } from "../../../../tests/support/fake-embedder.js";
import { createLanceDbStore } from "./lancedb-store.js";

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "qj-lancedb-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

vectorStoreContract("lancedb", (key) => createLanceDbStore(join(root, key)));

describe("LanceDB indexes (REQ-KNOW-01/AC4)", () => {
  it("REQ-KNOW-01/AC4: a vector index is built once the store passes the threshold, and search still finds by meaning", async () => {
    const embedder = createFakeEmbedder({ dimensions: 32 });
    const dir = join(root, "ann");
    const store = await createLanceDbStore(dir);
    const texts = Array.from(
      { length: 300 },
      (_, i) => `note ${String(i)} about topic${String(i % 30)} and item${String(i)}`,
    );
    const vectors = await embedder.embed(texts);
    await store.upsert(
      texts.map((text, i) => ({
        id: `f-${String(i)}`,
        source: "docs",
        path: `docs/f${String(i % 10)}.md`,
        section: "",
        modifiedAt: "2026-01-01T00:00:00.000Z",
        fileHash: "f",
        hash: `h${String(i)}`,
        tags: [],
        text,
        vector: vectors[i] ?? [],
      })),
    );
    await store.optimize(1_000);
    const db = await connect(join(dir, "lancedb"));
    const table = await db.openTable("chunks");
    expect((await table.listIndices()).map((i) => i.columns)).toEqual([["text"]]);
    await store.optimize(256);
    await table.checkoutLatest();
    expect((await table.listIndices()).map((i) => i.columns[0]).sort()).toEqual(["text", "vector"]);
    const [query = []] = await embedder.embed(["item123 topic3"]);
    expect(
      (await store.search({ text: "item123", vector: query, limit: 3 })).map((h) => h.chunk.id),
    ).toContain("f-123");
    table.close();
    db.close();
    await store.close();
  }, 120_000);
});

describe("LanceDB at scale (REQ-KNOW-01/AC4)", () => {
  it("REQ-KNOW-01/AC4: past the index threshold both indexes exist and keyword and hybrid search stay under one second", async () => {
    const dims = 32;
    const dir = join(root, "scale");
    const store = await createLanceDbStore(dir);
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const vector = () => Array.from({ length: dims }, () => rand() - 0.5);
    const total = 60_000;
    for (let i = 0; i < total; i += 10_000)
      await store.upsert(
        Array.from({ length: 10_000 }, (_, k) => {
          const j = i + k;
          return {
            id: `${(j >> 4).toString(16).padStart(16, "0")}-${String(j & 15)}`,
            source: "docs",
            path: `docs/f${String(j >> 4)}.md`,
            section: "",
            modifiedAt: "2026-01-01T00:00:00.000Z",
            fileHash: "f",
            hash: `h${String(j)}`,
            tags: j % 3 === 0 ? ["api"] : [],
            text: `chunk ${String(j)} about term${String(j % 997)} and term${String(j % 389)}`,
            vector: vector(),
          };
        }),
      );
    await store.optimize(50_000);
    const db = await connect(join(dir, "lancedb"));
    const table = await db.openTable("chunks");
    expect((await table.listIndices()).map((i) => i.columns[0]).sort()).toEqual(["text", "vector"]);
    table.close();
    db.close();
    for (const query of [
      { text: "term42 term17", limit: 8 },
      { text: "term42 term17", vector: vector(), limit: 8 },
      { text: "term42", vector: vector(), tags: ["api"], limit: 8 },
    ]) {
      const started = performance.now();
      const hits = await store.search(query);
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(hits.length).toBeGreaterThan(0);
    }
    expect((await store.search({ text: "term42", limit: 3 }))[0]?.chunk.text).toContain("term42");
    await store.close();
  }, 300_000);
});
