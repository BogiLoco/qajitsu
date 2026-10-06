import {
  AdapterError,
  ConfigError,
  fuseRankings,
  keywords,
  type KnowledgeChunk,
  type KnowledgeFile,
  type KnowledgeHit,
  type StoredChunk,
  type VectorStore,
} from "@qajitsu/core";
import { z } from "zod";

/** Options of a Chroma store. */
export interface ChromaStoreOptions {
  /** Server URL, e.g. `https://chroma.example.com`; https unless it is a loopback address. */
  readonly url: string;
  /** Token sent as `x-chroma-token` (resolved from a `secret://` reference by the caller). */
  readonly token?: string | undefined;
  /** Collection of this project: one per project, so projects never share chunks (REQ-KNOW-09/AC3). */
  readonly collection: string;
  readonly tenant?: string;
  readonly database?: string;
  readonly fetch?: typeof globalThis.fetch;
}

const LOOPBACK = /^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i;
const PAGE = 1_000;

const Meta = z.object({
  source: z.string(),
  path: z.string(),
  section: z.string(),
  modified_at: z.string(),
  file_hash: z.string(),
  hash: z.string(),
  chars: z.number(),
  tags: z.string(),
});
type Meta = z.infer<typeof Meta>;

const GetResult = z.object({
  ids: z.array(z.string()),
  documents: z.array(z.string().nullable()).nullish(),
  metadatas: z.array(Meta.loose().nullable()).nullish(),
});
const QueryResult = z.object({
  ids: z.array(z.array(z.string())),
  documents: z.array(z.array(z.string().nullable())).nullish(),
  metadatas: z.array(z.array(Meta.loose().nullable())).nullish(),
});
interface Handle {
  id: string;
  vectors: boolean;
}

const Collection = z.object({ id: z.string(), metadata: z.record(z.string(), z.unknown()).nullish() });

const toChunk = (
  id: string,
  text: string | null | undefined,
  m: Meta | null | undefined,
): KnowledgeChunk => ({
  id,
  source: m?.source ?? "",
  path: m?.path ?? "",
  section: m?.section ?? "",
  modifiedAt: m?.modified_at ?? "",
  fileHash: m?.file_hash ?? "",
  hash: m?.hash ?? "",
  tags: (m?.tags ?? "").split(",").filter(Boolean),
  text: text ?? "",
});

/** Scores a text by the query words it contains: matched words first, then term frequency. */
const keywordScore = (text: string, words: readonly string[]): number => {
  const lower = text.toLowerCase();
  let score = 0;
  for (const w of words) {
    const tf = lower.split(w).length - 1;
    if (tf > 0) score += 1 + Math.log(tf);
  }
  return score;
};

/**
 * VectorStore on a shared Chroma server (REQ-KNOW-08/AC3, ADR-0007) through its HTTP API, without the Chroma client
 * package. Each project has its own collection. Chunks without vectors (full mode) get a one-dimensional placeholder
 * embedding; keyword search narrows candidates with `$contains` and ranks them in code.
 *
 * @throws {ConfigError} `CHROMA_URL_INSECURE` for plain http to a non-loopback host.
 * @example
 * const store = await createChromaStore({ url, token, collection: "qajitsu-bank" });
 */
export function createChromaStore(options: ChromaStoreOptions): Promise<VectorStore> {
  return Promise.resolve().then(() => buildStore(options));
}

function buildStore(options: ChromaStoreOptions): VectorStore {
  const base = options.url.replace(/\/+$/, "");
  if (!base.startsWith("https://") && !LOOPBACK.test(base))
    throw new ConfigError("CHROMA_URL_INSECURE", "The Chroma URL must use https (or http on localhost).", {});
  const doFetch = options.fetch ?? globalThis.fetch;
  const prefix = `${base}/api/v2/tenants/${encodeURIComponent(options.tenant ?? "default_tenant")}/databases/${encodeURIComponent(options.database ?? "default_database")}/collections`;
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await doFetch(`${prefix}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(options.token ? { "x-chroma-token": options.token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok)
      throw new AdapterError(
        "CHROMA_REQUEST_FAILED",
        `Chroma ${method} ${path} failed with ${String(res.status)}.`,
        {
          status: res.status,
        },
      );
    return text === "" ? undefined : (JSON.parse(text) as unknown);
  };

  let handle: Handle | undefined;
  const find = async (): Promise<Handle | undefined> => {
    if (handle) return handle;
    try {
      const c = Collection.parse(await call("GET", `/${encodeURIComponent(options.collection)}`));
      handle = { id: c.id, vectors: c.metadata?.["qajitsu_vectors"] === true };
    } catch (error) {
      if (error instanceof AdapterError && error.context["status"] === 404) return undefined;
      throw error;
    }
    return handle;
  };
  const create = async (vectors: boolean): Promise<Handle> => {
    const c = Collection.parse(
      await call("POST", "", {
        name: options.collection,
        get_or_create: true,
        metadata: { qajitsu_vectors: vectors, "hnsw:space": "cosine" },
      }),
    );
    handle = { id: c.id, vectors: c.metadata?.["qajitsu_vectors"] === true };
    return handle;
  };

  const getAll = async (
    h: Handle,
    include: string[],
    where?: unknown,
  ): Promise<z.infer<typeof GetResult>> => {
    const out: z.infer<typeof GetResult> = { ids: [], documents: [], metadatas: [] };
    for (let offset = 0; ; offset += PAGE) {
      const page = GetResult.parse(
        await call("POST", `/${h.id}/get`, { include, limit: PAGE, offset, ...(where ? { where } : {}) }),
      );
      out.ids.push(...page.ids);
      out.documents?.push(...(page.documents ?? page.ids.map(() => null)));
      out.metadatas?.push(...(page.metadatas ?? page.ids.map(() => null)));
      if (page.ids.length < PAGE) return out;
    }
  };

  const tagWhere = (tags: readonly string[] | undefined): unknown => {
    if (!tags || tags.length === 0) return undefined;
    const clauses = tags.map((t) => ({ [`tag:${t}`]: { $eq: true } }));
    return clauses.length === 1 ? clauses[0] : { $or: clauses };
  };

  return {
    async upsert(chunks: readonly StoredChunk[]) {
      if (chunks.length === 0) return;
      const withVectors = chunks.filter((c) => c.vector !== undefined).length;
      if (withVectors !== 0 && withVectors !== chunks.length)
        throw new ConfigError("KNOWLEDGE_VECTORS_MIXED", "Either every chunk has a vector or none has.", {});
      const h = (await find()) ?? (await create(withVectors > 0));
      if (h.vectors !== withVectors > 0)
        throw new ConfigError(
          "KNOWLEDGE_MODE_MISMATCH",
          "The knowledge base was built in another retrieval mode; run 'qajitsu knowledge reindex'.",
          {},
        );
      await call("POST", `/${h.id}/upsert`, {
        ids: chunks.map((c) => c.id),
        documents: chunks.map((c) => c.text),
        embeddings: chunks.map((c) => (c.vector ? [...c.vector] : [0])),
        metadatas: chunks.map((c) => ({
          source: c.source,
          path: c.path,
          section: c.section,
          modified_at: c.modifiedAt,
          file_hash: c.fileHash,
          hash: c.hash,
          chars: c.text.length,
          tags: `,${c.tags.join(",")},`,
          ...Object.fromEntries(c.tags.map((t) => [`tag:${t}`, true])),
        })),
      });
    },

    async deleteFiles(paths) {
      const h = await find();
      if (!h || paths.length === 0) return 0;
      const where = { path: { $in: [...paths] } };
      const found = await getAll(h, [], where);
      if (found.ids.length > 0) await call("POST", `/${h.id}/delete`, { ids: found.ids });
      return found.ids.length;
    },

    async files() {
      const h = await find();
      if (!h) return [];
      const got = await getAll(h, ["metadatas"]);
      const files = new Map<string, KnowledgeFile>();
      got.metadatas?.forEach((m) => {
        if (!m) return;
        const known = files.get(m.path);
        files.set(m.path, {
          path: m.path,
          source: m.source,
          fileHash: m.file_hash,
          chunks: (known?.chunks ?? 0) + 1,
          chars: (known?.chars ?? 0) + m.chars,
        });
      });
      return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
    },

    async search(query): Promise<readonly KnowledgeHit[]> {
      const h = await find();
      if (!h) return [];
      const where = tagWhere(query.tags);
      const words = keywords(query.text);
      const pool = Math.max(query.limit * 4, 20);
      let byKeyword: KnowledgeChunk[] = [];
      if (words.length > 0) {
        // $contains is case-sensitive: ask for the usual spellings, rank case-insensitively in code.
        const contains = [
          ...new Set(words.flatMap((w) => [w, `${w.charAt(0).toUpperCase()}${w.slice(1)}`, w.toUpperCase()])),
        ].map((w) => ({ $contains: w }));
        const got = GetResult.parse(
          await call("POST", `/${h.id}/get`, {
            include: ["documents", "metadatas"],
            limit: 500,
            where_document: contains.length === 1 ? contains[0] : { $or: contains },
            ...(where ? { where } : {}),
          }),
        );
        byKeyword = got.ids
          .map((id, i) => toChunk(id, got.documents?.[i], got.metadatas?.[i]))
          .map((c) => ({ c, s: keywordScore(c.text, words) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s || a.c.id.localeCompare(b.c.id))
          .slice(0, pool)
          .map((x) => x.c);
      }
      if (query.vector === undefined || !h.vectors)
        return byKeyword.slice(0, query.limit).map((chunk, i) => ({ chunk, score: 1 / (i + 1) }));
      const q = QueryResult.parse(
        await call("POST", `/${h.id}/query`, {
          query_embeddings: [[...query.vector]],
          n_results: pool,
          include: ["documents", "metadatas"],
          ...(where ? { where } : {}),
        }),
      );
      const byVector = (q.ids[0] ?? []).map((id, i) =>
        toChunk(id, q.documents?.[0]?.[i], q.metadatas?.[0]?.[i]),
      );
      return fuseRankings([byVector, byKeyword], query.limit);
    },

    async get(ids) {
      const h = await find();
      if (!h || ids.length === 0) return [];
      const got = GetResult.parse(
        await call("POST", `/${h.id}/get`, { ids: [...ids], include: ["documents", "metadatas"] }),
      );
      const found = new Map(
        got.ids.map((id, i) => [id, toChunk(id, got.documents?.[i], got.metadatas?.[i])]),
      );
      return ids.flatMap((id) => {
        const c = found.get(id);
        return c ? [c] : [];
      });
    },

    async all() {
      const h = await find();
      if (!h) return [];
      const got = await getAll(h, ["documents", "metadatas"]);
      const ordinal = (id: string): number => Number(id.slice(id.lastIndexOf("-") + 1));
      return got.ids
        .map((id, i) => toChunk(id, got.documents?.[i], got.metadatas?.[i]))
        .sort((a, b) => a.path.localeCompare(b.path) || ordinal(a.id) - ordinal(b.id));
    },

    async count() {
      const h = await find();
      return h ? z.number().parse(await call("GET", `/${h.id}/count`)) : 0;
    },

    // Chroma maintains its HNSW index itself.
    optimize: () => Promise.resolve(),

    async reset() {
      if (await find()) await call("DELETE", `/${encodeURIComponent(options.collection)}`);
      handle = undefined;
    },

    close: () => Promise.resolve(),
  };
}
