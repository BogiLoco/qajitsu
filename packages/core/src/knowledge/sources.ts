import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { ConfigError } from "../errors.js";
import type { KnowledgeChunk, KnowledgeHit } from "../interfaces/knowledge-store.js";
import { sha256 } from "../plan/plan-store.js";

const SourceName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

/** A registered source: a file or folder with its filters and tags (REQ-KNOW-02/AC1+AC3). */
export const KnowledgeSourceSchema = z.strictObject({
  name: SourceName,
  /** Absolute path of the file or folder. */
  path: z.string().min(1),
  include: z.array(z.string().min(1)).default([]),
  exclude: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string().regex(/^[\w.-]{1,40}$/)).default([]),
  added_at: z.string(),
  synced_at: z.string().optional(),
});

/** A registered knowledge source. */
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;

/** `<project-home>/knowledge/sources.yaml` (REQ-KNOW-02/AC3). */
export const KnowledgeSourcesSchema = z.strictObject({
  schema: z.literal(1),
  sources: z.array(KnowledgeSourceSchema).default([]),
});

/**
 * `<project-home>/knowledge/index.json`: what the stored chunks were built with (REQ-KNOW-07/AC3, REQ-KNOW-08/AC2).
 * `embedding` is set only in hybrid mode, where every chunk has a vector from that model.
 */
export const KnowledgeIndexSchema = z.strictObject({
  schema: z.literal(1),
  store: z.enum(["lancedb", "chroma"]),
  mode: z.enum(["full", "hybrid"]),
  embedding: z.string().optional(),
  dimensions: z.number().int().positive().optional(),
  /** Total characters of all chunks; decides the mode against `knowledge.full_context_tokens`. */
  chars: z.number().int().nonnegative(),
  updated_at: z.string(),
});

/** Index metadata of a knowledge base. */
export type KnowledgeIndex = z.infer<typeof KnowledgeIndexSchema>;

const writeAtomic = async (file: string, text: string): Promise<void> => {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${String(process.pid)}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
};

/**
 * Reads `sources.yaml`; a missing file is an empty knowledge base (REQ-KNOW-01/AC1).
 *
 * @throws {ConfigError} `KNOWLEDGE_SOURCES_INVALID`.
 */
export async function readKnowledgeSources(dir: string): Promise<KnowledgeSource[]> {
  const text = await readFile(join(dir, "sources.yaml"), "utf8").catch(() => undefined);
  if (text === undefined) return [];
  const parsed = KnowledgeSourcesSchema.safeParse(parse(text));
  if (!parsed.success)
    throw new ConfigError("KNOWLEDGE_SOURCES_INVALID", `${join(dir, "sources.yaml")} is not valid.`, {});
  return parsed.data.sources;
}

/** Writes `sources.yaml` atomically. */
export async function writeKnowledgeSources(dir: string, sources: readonly KnowledgeSource[]): Promise<void> {
  await writeAtomic(join(dir, "sources.yaml"), stringify({ schema: 1, sources }));
}

/** Reads `index.json`, or undefined for a knowledge base that was never built. */
export async function readKnowledgeIndex(dir: string): Promise<KnowledgeIndex | undefined> {
  const text = await readFile(join(dir, "index.json"), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const parsed = KnowledgeIndexSchema.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : undefined;
}

/** Writes `index.json` atomically. */
export async function writeKnowledgeIndex(dir: string, index: KnowledgeIndex): Promise<void> {
  await writeAtomic(join(dir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
}

/** Id of a chunk: a hash of its file path plus its ordinal, so re-chunking a file replaces its chunks. */
export function chunkId(path: string, ordinal: number): string {
  return `${sha256(path).slice(0, 16)}-${String(ordinal)}`;
}

/**
 * Retrieval mode for documentation of `chars` characters (REQ-KNOW-07/AC1+AC2): in full (no embeddings) while it
 * fits the budget at about 4 characters per token, hybrid above it.
 */
export function retrievalMode(chars: number, fullContextTokens: number): "full" | "hybrid" {
  return chars <= fullContextTokens * 4 ? "full" : "hybrid";
}

/**
 * Fuses ranked lists with reciprocal rank fusion (k = 60): the hybrid ranking of vector and keyword results
 * (REQ-KNOW-07/AC2).
 *
 * @param lists - Ranked lists, best first.
 * @param limit - Number of results.
 */
export function fuseRankings(lists: readonly (readonly KnowledgeChunk[])[], limit: number): KnowledgeHit[] {
  const scores = new Map<string, { chunk: KnowledgeChunk; score: number }>();
  for (const list of lists)
    list.forEach((chunk, rank) => {
      const entry = scores.get(chunk.id) ?? { chunk, score: 0 };
      entry.score += 1 / (60 + rank + 1);
      scores.set(chunk.id, entry);
    });
  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
    .slice(0, limit);
}

/** Words of a text for keyword matching: lowercase letters and digits, two characters or more. */
export const keywords = (text: string): string[] =>
  (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((w, i, all) => all.indexOf(w) === i);

const normalize = (text: string): string =>
  text
    .replace(/[\s*_`>#-]+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Checks that a quote cited from documentation appears verbatim (ignoring whitespace and Markdown emphasis) in the
 * stored chunk (REQ-KNOW-06/AC3).
 *
 * @returns Why the quote is not grounded, or undefined.
 */
export function checkDocQuote(quote: string, chunk: KnowledgeChunk | undefined): string | undefined {
  if (chunk === undefined) return "no such documentation chunk in the project's knowledge base";
  const q = normalize(quote);
  if (q.length < 12) return "the quote is too short to be checked";
  return normalize(chunk.text).includes(q) ? undefined : `the quote is not in ${chunk.path}`;
}

/**
 * Whether a chunk's file is older than `maxAgeDays` at `now` (REQ-KNOW-10/AC1).
 */
export function isOutdated(
  chunk: Pick<KnowledgeChunk, "modifiedAt">,
  maxAgeDays: number | undefined,
  now: Date,
): boolean {
  if (maxAgeDays === undefined) return false;
  const modified = Date.parse(chunk.modifiedAt);
  return Number.isFinite(modified) && now.getTime() - modified > maxAgeDays * 86_400_000;
}
