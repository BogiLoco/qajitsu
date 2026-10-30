import { createHash } from "node:crypto";
import type { ContextFragment, Embedder } from "@qajitsu/core";

const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * The embedding model as a second signal for choosing context (REQ-CTX-20): it ranks, finds near-duplicates and
 * related files, and never decides alone or summarises. Vectors are computed once per text hash and model (AC6).
 */
export interface SemanticIndex {
  /** The embedding model and its version, recorded in every snapshot that used it (AC6). */
  readonly model: string;
  readonly version?: string | undefined;
  /** Vectors of texts by a key (a fragment hash), from the cache when the same key and model were embedded before. */
  vectors(items: readonly { readonly key: string; readonly text: string }[]): Promise<number[][]>;
}

/** The most text of a fragment that is embedded: enough for its subject, cheap for a local model. */
const EMBED_CHARS = 4_000;

/**
 * A semantic index over an embedding model with a per-run cache by key and model (REQ-CTX-20/AC6).
 *
 * @param embedder - The project's embedding model (REQ-KNOW-08).
 * @param options - Its version, when the provider names one, and a shared cache (e.g. one per project).
 */
export function createSemanticIndex(
  embedder: Embedder,
  options: { readonly version?: string; readonly cache?: Map<string, number[]> } = {},
): SemanticIndex {
  const cache = options.cache ?? new Map<string, number[]>();
  const id = `${embedder.id}@${options.version ?? "-"}`;
  return {
    model: embedder.id,
    version: options.version,
    vectors: async (items) => {
      const missing = [
        ...new Map(items.filter((i) => !cache.has(`${id}:${i.key}`)).map((i) => [i.key, i])).values(),
      ];
      if (missing.length > 0) {
        const vectors = await embedder.embed(missing.map((i) => i.text.slice(0, EMBED_CHARS)));
        missing.forEach((i, n) => cache.set(`${id}:${i.key}`, vectors[n] ?? []));
      }
      return items.map((i) => cache.get(`${id}:${i.key}`) ?? []);
    },
  };
}

/** Cosine similarity; 0 for empty or mismatched vectors. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

const textOf = (f: ContextFragment): string => `${f.source}\n${f.text}`;

/**
 * Similarity of each competing fragment to the task (REQ-CTX-20/AC1): to the text of the anchors (the ticket and its
 * criteria, the plan, the question). Pinned fragments and instructions are not ranked.
 *
 * @param index - The semantic index.
 * @param fragments - The call's fragments.
 */
export async function similarities(
  index: SemanticIndex,
  fragments: readonly ContextFragment[],
): Promise<Map<string, number>> {
  const anchors = fragments.filter((f) => f.pinned || f.kind === "ticket" || f.kind === "question");
  const competing = fragments.filter((f) => !f.pinned && f.kind !== "role-instructions");
  if (anchors.length === 0 || competing.length === 0) return new Map();
  const anchorText = anchors
    .map((f) => f.text)
    .join("\n")
    .slice(0, EMBED_CHARS);
  const [task = [], ...vectors] = await index.vectors([
    {
      key: hashOf(anchorText),
      text: anchorText,
    },
    ...competing.map((f) => ({ key: f.sha256, text: textOf(f) })),
  ]);
  return new Map(
    competing.map((f, i) => [f.sha256, Math.round(cosine(task, vectors[i] ?? []) * 1000) / 1000]),
  );
}

/**
 * A text with what differs between attempts of the same thing left out: numbers, hex ids, times, quoted values and
 * spacing. Two fragments with the same shape say the same thing.
 */
export function shapeOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, "<time>")
    .replace(/\b[0-9a-f]{8,}\b/g, "<id>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/** Code's confirmation that two texts are near-identical (REQ-CTX-20/AC3): the same shape, or 90% shared lines. */
export function sameShape(a: string, b: string): boolean {
  if (shapeOf(a) === shapeOf(b)) return true;
  const la = new Set(a.split("\n").map(shapeOf).filter(Boolean));
  const lb = new Set(b.split("\n").map(shapeOf).filter(Boolean));
  const shared = [...la].filter((l) => lb.has(l)).length;
  return shared / Math.max(la.size, lb.size, 1) >= 0.9;
}

/**
 * Near-identical fragments (REQ-CTX-20/AC3): pairs over the similarity threshold whose texts code confirms as the same
 * shape. Returns each later fragment's hash with the hash of the one kept; pinned fragments are never matched.
 *
 * @param index - The semantic index.
 * @param fragments - The call's fragments, in their order.
 * @param threshold - Similarity above which a pair is checked by code.
 */
export async function nearDuplicates(
  index: SemanticIndex,
  fragments: readonly ContextFragment[],
  threshold = 0.9,
): Promise<Map<string, string>> {
  const candidates = fragments.filter(
    (f) => !f.pinned && f.kind !== "role-instructions" && f.trust === "untrusted",
  );
  const vectors = await index.vectors(candidates.map((f) => ({ key: f.sha256, text: textOf(f) })));
  const twins = new Map<string, string>();
  candidates.forEach((f, i) => {
    if (twins.has(f.sha256)) return;
    for (let j = i + 1; j < candidates.length; j += 1) {
      const g = candidates[j];
      if (!g || g.sha256 === f.sha256 || twins.has(g.sha256) || g.kind !== f.kind) continue;
      if (cosine(vectors[i] ?? [], vectors[j] ?? []) >= threshold && sameShape(f.text, g.text))
        twins.set(g.sha256, f.sha256);
    }
  });
  return twins;
}

/**
 * Catalogue entries ranked by meaning for a question (REQ-CTX-20/AC2): similarity of each entry to the question.
 *
 * @param index - The semantic index.
 * @param question - What the role looks for.
 * @param entries - The catalogue's fragments by handle.
 * @param limit - How many to return.
 */
export async function searchByMeaning(
  index: SemanticIndex,
  question: string,
  entries: readonly { readonly handle: string; readonly fragment: ContextFragment }[],
  limit: number,
): Promise<{ handle: string; score: number }[]> {
  if (entries.length === 0) return [];
  const [q = [], ...vectors] = await index.vectors([
    { key: hashOf(question), text: question },
    ...entries.map((e) => ({ key: e.fragment.sha256, text: textOf(e.fragment) })),
  ]);
  return entries
    .map((e, i) => ({ handle: e.handle, score: cosine(q, vectors[i] ?? []) }))
    .filter((x) => x.score > 0.2)
    .sort((a, b) => b.score - a.score || (a.handle < b.handle ? -1 : 1))
    .slice(0, limit);
}

/**
 * Groups of a split joined by meaning (REQ-CTX-19 with REQ-CTX-20/AC4): a group of one file that the code's links did
 * not connect joins the most similar other group when the similarity reaches the threshold. Returns the new group key
 * of each moved group; the code's groups stay as they are otherwise.
 *
 * @param index - The semantic index.
 * @param groups - Group key and the text of its diff, in a fixed order.
 * @param threshold - Similarity a lone group needs to join another.
 */
export async function joinBySimilarity(
  index: SemanticIndex,
  groups: readonly { readonly key: string; readonly files: number; readonly text: string }[],
  threshold = 0.8,
): Promise<Map<string, string>> {
  if (groups.length < 2) return new Map();
  const vectors = await index.vectors(groups.map((g) => ({ key: hashOf(g.text), text: g.text })));
  const moved = new Map<string, string>();
  groups.forEach((g, i) => {
    if (g.files !== 1) return;
    let best: { key: string; score: number } | undefined;
    groups.forEach((h, j) => {
      if (i === j || moved.has(h.key)) return;
      const score = cosine(vectors[i] ?? [], vectors[j] ?? []);
      if (score >= threshold && (!best || score > best.score)) best = { key: h.key, score };
    });
    if (best) moved.set(g.key, best.key);
  });
  return moved;
}
