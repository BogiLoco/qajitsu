/**
 * An in-memory Chroma server for tests: the subset of the HTTP API v2 the knowledge-chroma adapter uses
 * (collections by name, upsert, get with where / where_document, query by cosine distance, count, delete).
 */
interface Row {
  document: string;
  embedding: number[];
  metadata: Record<string, unknown>;
}
interface FakeCollection {
  id: string;
  name: string;
  metadata: Record<string, unknown>;
  rows: Map<string, Row>;
}

type Where = Record<string, unknown>;
const matches = (meta: Record<string, unknown>, where: Where | undefined): boolean => {
  if (!where) return true;
  if (Array.isArray(where["$or"])) return (where["$or"] as Where[]).some((w) => matches(meta, w));
  if (Array.isArray(where["$and"])) return (where["$and"] as Where[]).every((w) => matches(meta, w));
  return Object.entries(where).every(([k, cond]) => {
    const c = cond as Record<string, unknown>;
    if ("$eq" in c) return meta[k] === c["$eq"];
    if ("$in" in c) return (c["$in"] as unknown[]).includes(meta[k]);
    return meta[k] === cond;
  });
};
const docMatches = (doc: string, where: Where | undefined): boolean => {
  if (!where) return true;
  if (Array.isArray(where["$or"])) return (where["$or"] as Where[]).some((w) => docMatches(doc, w));
  return typeof where["$contains"] === "string" ? doc.includes(where["$contains"]) : true;
};
const cosine = (a: number[], b: number[]): number => {
  const dot = a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);
  return 1 - dot / ((Math.hypot(...a) || 1) * (Math.hypot(...b) || 1));
};

export function createFakeChroma() {
  const collections = new Map<string, FakeCollection>();
  const requests: { method: string; path: string; token: string | null }[] = [];
  let seq = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const byId = (id: string) => [...collections.values()].find((c) => c.id === id);

  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    requests.push({ method, path: url.pathname, token: headers.get("x-chroma-token") });
    const m =
      /^\/api\/v2\/tenants\/default_tenant\/databases\/default_database\/collections(?:\/([^/]+))?(?:\/(\w+))?$/.exec(
        url.pathname,
      );
    if (!m) return Promise.resolve(json({ error: "not found" }, 404));
    const body = (typeof init?.body === "string" ? JSON.parse(init.body) : {}) as Record<string, unknown>;
    const [, ref, action] = m;
    if (!ref && method === "POST") {
      const name = String(body["name"]);
      const existing = collections.get(name);
      if (existing) return Promise.resolve(json(existing));
      const c = {
        id: `c${String((seq += 1))}`,
        name,
        metadata: (body["metadata"] ?? {}) as Record<string, unknown>,
        rows: new Map(),
      };
      collections.set(name, c);
      return Promise.resolve(json({ id: c.id, name, metadata: c.metadata }));
    }
    if (ref && !action) {
      const c = collections.get(decodeURIComponent(ref));
      if (!c) return Promise.resolve(json({ error: "missing" }, 404));
      if (method === "DELETE") {
        collections.delete(c.name);
        return Promise.resolve(json({}));
      }
      return Promise.resolve(json({ id: c.id, name: c.name, metadata: c.metadata }));
    }
    const c = ref ? byId(ref) : undefined;
    if (!c) return Promise.resolve(json({ error: "missing" }, 404));
    const pick = (ids: string[]) => ({
      ids,
      documents: ids.map((id) => c.rows.get(id)?.document ?? null),
      metadatas: ids.map((id) => c.rows.get(id)?.metadata ?? null),
    });
    switch (action) {
      case "upsert": {
        const ids = body["ids"] as string[];
        ids.forEach((id, i) =>
          c.rows.set(id, {
            document: (body["documents"] as string[])[i] ?? "",
            embedding: (body["embeddings"] as number[][])[i] ?? [],
            metadata: (body["metadatas"] as Record<string, unknown>[])[i] ?? {},
          }),
        );
        return Promise.resolve(json({}));
      }
      case "get": {
        let ids = Array.isArray(body["ids"])
          ? (body["ids"] as string[]).filter((id) => c.rows.has(id))
          : [...c.rows.keys()].sort();
        ids = ids.filter((id) => {
          const r = c.rows.get(id);
          return (
            r !== undefined &&
            matches(r.metadata, body["where"] as Where) &&
            docMatches(r.document, body["where_document"] as Where)
          );
        });
        const offset = Number(body["offset"] ?? 0);
        ids = ids.slice(offset, body["limit"] === undefined ? undefined : offset + Number(body["limit"]));
        return Promise.resolve(json(pick(ids)));
      }
      case "query": {
        const [q = []] = body["query_embeddings"] as number[][];
        const ids = [...c.rows.entries()]
          .filter(([, r]) => matches(r.metadata, body["where"] as Where))
          .sort(([, a], [, b]) => cosine(q, a.embedding) - cosine(q, b.embedding))
          .slice(0, Number(body["n_results"] ?? 10))
          .map(([id]) => id);
        const p = pick(ids);
        return Promise.resolve(json({ ids: [p.ids], documents: [p.documents], metadatas: [p.metadatas] }));
      }
      case "delete":
        for (const id of body["ids"] as string[]) c.rows.delete(id);
        return Promise.resolve(json({}));
      case "count":
        return Promise.resolve(json(c.rows.size));
      case undefined:
      default:
        return Promise.resolve(json({ error: "unsupported" }, 404));
    }
  };
  return { fetch, collections, requests };
}
