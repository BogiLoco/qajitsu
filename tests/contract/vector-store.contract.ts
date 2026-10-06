import type { KnowledgeChunk, StoredChunk, VectorStore } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createFakeEmbedder } from "../support/fake-embedder.js";

const DOCS: readonly Omit<KnowledgeChunk, "hash" | "fileHash" | "modifiedAt" | "source">[] = [
  {
    id: "orders-0",
    path: "docs/orders.md",
    section: "Orders > Cancel",
    tags: ["api"],
    text: "A paid order can be cancelled within 24 hours of payment.",
  },
  {
    id: "orders-1",
    path: "docs/orders.md",
    section: "Orders > Refund",
    tags: ["api"],
    text: "Refunds go back to the original card in five working days.",
  },
  {
    id: "cart-0",
    path: "docs/cart.md",
    section: "Cart",
    tags: ["web"],
    text: "The cart keeps at most twenty items and shows the total with tax.",
  },
  {
    id: "login-0",
    path: "docs/login.md",
    section: "Login",
    tags: ["web", "security"],
    text: "Three failed logins lock the account for fifteen minutes.",
  },
];

const chunks = (): KnowledgeChunk[] =>
  DOCS.map((d) => ({
    ...d,
    source: "docs",
    hash: `h-${d.id}`,
    fileHash: `f-${d.path}`,
    modifiedAt: "2026-09-01T00:00:00.000Z",
  }));

/**
 * Shared contract every VectorStore passes (REQ-KNOW-01/AC3+AC4, REQ-KNOW-03/AC1, ADR-0007): upserts by id, deletes
 * per file, keyword and hybrid search with tag filters, and nothing from another store.
 *
 * @param name - Implementation name for test titles.
 * @param create - Builds an empty store in a fresh location; `key` names the location, the same key reopens it.
 */
export function vectorStoreContract(name: string, create: (key: string) => Promise<VectorStore>): void {
  const embedder = createFakeEmbedder();
  const withVectors = async (list: readonly KnowledgeChunk[]): Promise<StoredChunk[]> => {
    const vectors = await embedder.embed(list.map((c) => c.text));
    return list.map((c, i) => ({ ...c, vector: vectors[i] ?? [] }));
  };

  describe(`VectorStore contract: ${name}`, () => {
    it("REQ-KNOW-01/AC1+AC3: an empty store answers every read with nothing", async () => {
      const store = await create("empty");
      expect(await store.count()).toBe(0);
      expect(await store.files()).toEqual([]);
      expect(await store.all()).toEqual([]);
      expect(await store.search({ text: "order", limit: 3 })).toEqual([]);
      expect(await store.get(["x"])).toEqual([]);
      expect(await store.deleteFiles(["docs/a.md"])).toBe(0);
      await store.optimize(256);
      await store.close();
    });

    it("REQ-KNOW-02/AC5 + REQ-KNOW-05/AC2: keyword search ranks matching chunks with path, section and date", async () => {
      const store = await create("keyword");
      await store.upsert(chunks());
      expect(await store.count()).toBe(4);
      const hits = await store.search({ text: "cancel paid order cancelled", limit: 2 });
      expect(hits[0]?.chunk).toEqual(chunks()[0]);
      expect(hits.length).toBeLessThanOrEqual(2);
      expect(
        (await store.search({ text: "account locked logins", limit: 5, tags: ["api"] })).map(
          (h) => h.chunk.id,
        ),
      ).not.toContain("login-0");
      expect(
        (await store.search({ text: "logins", limit: 5, tags: ["security"] })).map((h) => h.chunk.id),
      ).toEqual(["login-0"]);
      await store.close();
    });

    it("REQ-KNOW-01/AC4: upsert replaces chunks by id without duplicates; reopening keeps them", async () => {
      const store = await create("upsert");
      await store.upsert(chunks());
      const changed = {
        ...chunks()[1],
        text: "Refunds take ten working days now.",
        hash: "h2",
      } as KnowledgeChunk;
      await store.upsert([changed]);
      expect(await store.count()).toBe(4);
      expect(await store.get(["orders-1", "missing", "cart-0"])).toEqual([changed, chunks()[2]]);
      expect((await store.search({ text: "ten working days", limit: 1 }))[0]?.chunk.id).toBe("orders-1");
      await store.close();
      const again = await create("upsert");
      expect(await again.count()).toBe(4);
      expect((await again.files()).map((f) => [f.path, f.chunks, f.fileHash, f.chars])).toEqual([
        ["docs/cart.md", 1, "f-docs/cart.md", chunks()[2]?.text.length],
        ["docs/login.md", 1, "f-docs/login.md", chunks()[3]?.text.length],
        ["docs/orders.md", 2, "f-docs/orders.md", (chunks()[0]?.text.length ?? 0) + changed.text.length],
      ]);
      await again.close();
    });

    it("REQ-KNOW-03/AC1: deleted files are never returned by a following search", async () => {
      const store = await create("delete");
      await store.upsert(chunks());
      expect(await store.deleteFiles(["docs/orders.md", "docs/none.md"])).toBe(2);
      expect(
        (await store.search({ text: "paid order cancelled refunds", limit: 10 })).map((h) => h.chunk.path),
      ).not.toContain("docs/orders.md");
      expect((await store.all()).map((c) => c.id)).toEqual(["cart-0", "login-0"]);
      await store.reset();
      expect(await store.count()).toBe(0);
      await store.upsert(chunks());
      expect(await store.count()).toBe(4);
      await store.close();
    });

    it("REQ-KNOW-07/AC2: with vectors, hybrid search finds chunks by meaning and keywords; modes do not mix", async () => {
      const store = await create("hybrid");
      await store.upsert(await withVectors(chunks()));
      const [query = []] = await embedder.embed(["how long until a refund reaches the card"]);
      const hits = await store.search({ text: "refund card", vector: query, limit: 2 });
      expect(hits[0]?.chunk.id).toBe("orders-1");
      await expect(store.upsert(chunks().slice(0, 1))).rejects.toThrow(/reindex/);
      await store.optimize(256);
      expect((await store.search({ text: "refund", vector: query, limit: 1 }))[0]?.chunk.id).toBe("orders-1");
      await store.close();
    });

    it("REQ-KNOW-09/AC3: two stores never see each other's chunks", async () => {
      const a = await create("project-a");
      const b = await create("project-b");
      await a.upsert(chunks());
      expect(await b.count()).toBe(0);
      expect(await b.search({ text: "order", limit: 5 })).toEqual([]);
      await a.close();
      await b.close();
    });
  });
}
