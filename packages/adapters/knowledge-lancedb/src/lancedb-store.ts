import { connect, Index, type Connection, type Table } from "@lancedb/lancedb";
import {
  ConfigError,
  fuseRankings,
  keywords,
  type KnowledgeChunk,
  type KnowledgeFile,
  type KnowledgeHit,
  type KnowledgeQuery,
  type StoredChunk,
  type VectorStore,
} from "@qajitsu/core";

const TABLE = "chunks";

interface Row {
  id: string;
  source: string;
  path: string;
  section: string;
  modified_at: string;
  file_hash: string;
  hash: string;
  /** Tags as `,a,b,` so a tag filter is a plain LIKE. */
  tags: string;
  text: string;
  chars: number;
  vector?: number[];
  _score?: number;
  _distance?: number;
}

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const inList = (column: string, values: readonly string[]): string =>
  `${column} IN (${values.map(quote).join(", ")})`;

const toRow = (c: StoredChunk): Row => ({
  id: c.id,
  source: c.source,
  path: c.path,
  section: c.section,
  modified_at: c.modifiedAt,
  file_hash: c.fileHash,
  hash: c.hash,
  tags: `,${c.tags.join(",")},`,
  text: c.text,
  chars: c.text.length,
  ...(c.vector ? { vector: [...c.vector] } : {}),
});

const toChunk = (r: Row): KnowledgeChunk => ({
  id: r.id,
  source: r.source,
  path: r.path,
  section: r.section,
  modifiedAt: r.modified_at,
  fileHash: r.file_hash,
  hash: r.hash,
  tags: r.tags.split(",").filter(Boolean),
  text: r.text,
});

const CHUNK_COLUMNS = ["id", "source", "path", "section", "modified_at", "file_hash", "hash", "tags", "text"];

/**
 * The default VectorStore (REQ-KNOW-01/AC3+AC4, ADR-0007): LanceDB embedded in the process, one database in the
 * project's `knowledge/` folder. Chunks are merged by id and deleted per file; a full-text index serves keyword
 * search, and above `optimize`'s threshold an IVF-PQ vector index serves approximate search.
 *
 * @param dir - The project's knowledge folder; nothing is read or written outside it (REQ-KNOW-09/AC3).
 * @example
 * const store = await createLanceDbStore(project.paths.knowledge);
 * const hits = await store.search({ text: "cancel a paid order", limit: 5 });
 */
export async function createLanceDbStore(dir: string): Promise<VectorStore> {
  const db: Connection = await connect(`${dir}/lancedb`);
  let table: Table | undefined = await db.openTable(TABLE).catch(() => undefined);

  const hasVectors = async (t: Table): Promise<boolean> =>
    (await t.schema()).fields.some((f) => f.name === "vector");

  const ensureFts = async (t: Table): Promise<void> => {
    const indices = await t.listIndices();
    if (!indices.some((i) => i.columns.includes("text")))
      await t.createIndex("text", { config: Index.fts({ withPosition: false }) });
  };

  const rows = async (t: Table, where: string | undefined, limit?: number): Promise<Row[]> => {
    let q = t.query().select(CHUNK_COLUMNS);
    if (where !== undefined) q = q.where(where);
    if (limit !== undefined) q = q.limit(limit);
    return (await q.toArray()) as Row[];
  };

  const tagFilter = (tags: readonly string[] | undefined): string | undefined =>
    tags === undefined || tags.length === 0
      ? undefined
      : `(${tags.map((t) => `tags LIKE ${quote(`%,${t},%`)}`).join(" OR ")})`;

  return {
    async upsert(chunks) {
      if (chunks.length === 0) return;
      const withVectors = chunks.filter((c) => c.vector !== undefined).length;
      if (withVectors !== 0 && withVectors !== chunks.length)
        throw new ConfigError("KNOWLEDGE_VECTORS_MIXED", "Either every chunk has a vector or none has.", {});
      const data = chunks.map(toRow) as unknown as Record<string, unknown>[];
      if (!table) {
        table = await db.createTable(TABLE, data);
      } else {
        if ((await hasVectors(table)) !== withVectors > 0)
          throw new ConfigError(
            "KNOWLEDGE_MODE_MISMATCH",
            "The knowledge base was built in another retrieval mode; run 'qajitsu knowledge reindex'.",
            {},
          );
        await table.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(data);
      }
      await ensureFts(table);
    },

    async deleteFiles(paths) {
      if (!table || paths.length === 0) return 0;
      const filter = inList("path", paths);
      const before = await table.countRows(filter);
      if (before > 0) await table.delete(filter);
      return before;
    },

    async files() {
      if (!table) return [];
      const files = new Map<string, KnowledgeFile>();
      for (const r of (await table
        .query()
        .select(["path", "source", "file_hash", "chars"])
        .toArray()) as Row[]) {
        const known = files.get(r.path);
        files.set(r.path, {
          path: r.path,
          source: r.source,
          fileHash: r.file_hash,
          chunks: (known?.chunks ?? 0) + 1,
          chars: (known?.chars ?? 0) + r.chars,
        });
      }
      return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
    },

    async search(query: KnowledgeQuery): Promise<readonly KnowledgeHit[]> {
      if (!table) return [];
      const filter = tagFilter(query.tags);
      const words = keywords(query.text).join(" ");
      const pool = Math.max(query.limit * 4, 20);
      let byKeyword: Row[] = [];
      if (words !== "") {
        let q = table
          .query()
          .fullTextSearch(words, { columns: "text" })
          .select([...CHUNK_COLUMNS, "_score"])
          .limit(pool);
        if (filter !== undefined) q = q.where(filter);
        byKeyword = (await q.toArray()) as Row[];
      }
      if (query.vector === undefined || !(await hasVectors(table)))
        return byKeyword.slice(0, query.limit).map((r) => ({ chunk: toChunk(r), score: r._score ?? 0 }));
      let v = table
        .query()
        .nearestTo([...query.vector])
        .distanceType("cosine")
        .select([...CHUNK_COLUMNS, "_distance"])
        .limit(pool);
      if (filter !== undefined) v = v.where(filter);
      const byVector = (await v.toArray()) as Row[];
      return fuseRankings([byVector.map(toChunk), byKeyword.map(toChunk)], query.limit);
    },

    async get(ids) {
      if (!table || ids.length === 0) return [];
      const found = new Map((await rows(table, inList("id", ids))).map((r) => [r.id, toChunk(r)]));
      return ids.flatMap((id) => {
        const c = found.get(id);
        return c ? [c] : [];
      });
    },

    async all() {
      if (!table) return [];
      return (await rows(table, undefined))
        .map(toChunk)
        .sort((a, b) => a.path.localeCompare(b.path) || ordinal(a.id) - ordinal(b.id));
    },

    async count() {
      return table ? table.countRows() : 0;
    },

    async optimize(threshold) {
      if (!table) return;
      const indices = await table.listIndices();
      if (
        (await hasVectors(table)) &&
        !indices.some((i) => i.columns.includes("vector")) &&
        (await table.countRows()) >= threshold
      )
        await table.createIndex("vector", { config: Index.ivfPq({ distanceType: "cosine" }) });
      // Folds new and deleted rows into the existing indexes and compacts small fragments.
      await table.optimize();
    },

    async reset() {
      if (table) await db.dropTable(TABLE);
      table = undefined;
    },

    close() {
      table?.close();
      db.close();
      return Promise.resolve();
    },
  };
}

const ordinal = (id: string): number => Number(id.slice(id.lastIndexOf("-") + 1));
