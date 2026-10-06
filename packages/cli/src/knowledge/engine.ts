import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import {
  ConfigError,
  chunkId,
  chunkSections,
  extractDocument,
  isNeverIndexed,
  maskCredentials,
  readKnowledgeIndex,
  retrievalMode,
  sha256,
  writeKnowledgeIndex,
  type DocumentSource,
  type Embedder,
  type Extracted,
  type KnowledgeFile,
  type KnowledgeChunk,
  type KnowledgeIndex,
  type KnowledgeSource,
  type ProjectConfig,
  type StoredChunk,
  type VectorStore,
} from "@qajitsu/core";

/** What a knowledge command works on: one project's store and settings. */
export interface KnowledgeContext {
  /** `<project-home>/knowledge/`. */
  readonly dir: string;
  readonly store: VectorStore;
  readonly config: ProjectConfig["knowledge"];
  /** The configured embedding model; only created when retrieval is hybrid. */
  readonly embedder: () => Promise<Embedder>;
  /** Masks registered secret values (the project's masker). */
  readonly maskSecrets: (text: string) => string;
  /** Asks once per project before document text goes to a cloud embedding model (REQ-KNOW-09/AC2). */
  readonly confirmCloud: (embedder: Embedder) => Promise<void>;
  readonly now: () => Date;
  /** The online reader of a Confluence or Jira source (REQ-KNOW-12). */
  readonly documentSource?: (source: KnowledgeSource) => Promise<DocumentSource>;
}

/** Outcome of a sync, by display path (REQ-KNOW-02/AC4). */
export interface SyncReport {
  readonly added: string[];
  readonly updated: string[];
  readonly unchanged: string[];
  readonly removed: string[];
  readonly skipped: { readonly path: string; readonly reason: string }[];
  readonly mode: "full" | "hybrid";
  readonly chunks: number;
  readonly rebuilt: boolean;
}

const SKIPPED_DIRS = new Set([".git", "node_modules", ".qa-runs", "dist", ".venv", "__pycache__"]);

/** Glob to RegExp: `**` any path, `*` within a segment, `?` one character; a glob without `/` matches a base name. */
export function globMatch(glob: string, path: string): boolean {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replaceAll("\u0000", ".*");
  return new RegExp(glob.includes("/") ? `^${body}$` : `(^|/)${body}$`).test(path);
}

interface ScannedFile {
  readonly abs: string;
  /** `<source>/<path relative to the source root>`. */
  readonly display: string;
  readonly rel: string;
}

/** Files of a source after include, exclude and never-indexed filters; never-indexed files are reported. */
async function scanSource(
  source: KnowledgeSource,
  skipped: SyncReport["skipped"],
): Promise<ScannedFile[] | undefined> {
  const info = await stat(source.path).catch(() => undefined);
  if (!info) return undefined;
  const files: ScannedFile[] = [];
  const visit = (abs: string, rel: string): void => {
    const display = `${source.name}/${rel}`;
    if (source.exclude.some((g) => globMatch(g, rel))) return;
    if (isNeverIndexed(rel)) {
      skipped.push({ path: display, reason: "never indexed (environment, key or credential file)" });
      return;
    }
    if (source.include.length > 0 && !source.include.some((g) => globMatch(g, rel))) return;
    files.push({ abs, display, rel });
  };
  if (info.isFile()) {
    visit(source.path, basename(source.path));
    return files;
  }
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(abs);
      } else if (entry.isFile()) visit(abs, relative(source.path, abs).split(sep).join("/"));
    }
  };
  await walk(source.path);
  return files;
}

/**
 * Text of a PDF per page through pdf.js (`unpdf`, loaded only for PDF files); PDFs without a text layer, such as
 * scans, are skipped with the reason (REQ-KNOW-02/AC2).
 */
export async function extractPdf(bytes: Buffer): Promise<Extracted> {
  const { extractText } = await import("unpdf");
  let pages: string[];
  try {
    pages = (await extractText(new Uint8Array(bytes), { mergePages: false })).text;
  } catch {
    return { ok: false, reason: "not a readable PDF file" };
  }
  const sections = pages
    .map((text, i) => ({ section: `page ${String(i + 1)}`, text: text.replace(/[ \t]+/g, " ").trim() }))
    .filter((p) => p.text !== "");
  return sections.length === 0
    ? { ok: false, reason: "PDF has no text layer (scanned image?)" }
    : { ok: true, format: "text", sections };
}

/** Chunks of one file, masked before chunking (REQ-KNOW-02/AC5, REQ-KNOW-09/AC1). */
async function chunksOf(
  file: Pick<ScannedFile, "display" | "rel">,
  source: KnowledgeSource,
  bytes: Buffer,
  modifiedAt: string,
  mask: (text: string) => string,
  remote?: { readonly version: string; readonly tags: readonly string[] },
): Promise<KnowledgeChunk[] | string> {
  const extracted = /\.pdf$/i.test(file.rel) ? await extractPdf(bytes) : extractDocument(file.rel, bytes);
  if (!extracted.ok) return extracted.reason;
  const fileHash = remote ? remote.version : sha256(bytes);
  const tags = remote ? [...new Set([...source.tags, ...remote.tags])] : source.tags;
  const sections = extracted.sections.map((s) => ({ section: mask(s.section), text: mask(s.text) }));
  return chunkSections(sections).map((c, i) => ({
    id: chunkId(file.display, i),
    source: source.name,
    path: file.display,
    section: c.section,
    modifiedAt,
    fileHash,
    hash: sha256(c.text),
    tags,
    text: c.text,
  }));
}

const BATCH = 64;

async function withVectors(chunks: readonly KnowledgeChunk[], embedder: Embedder): Promise<StoredChunk[]> {
  const out: StoredChunk[] = [];
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const vectors = await embedder.embed(batch.map((c) => `${c.section}\n${c.text}`));
    batch.forEach((c, j) => out.push({ ...c, vector: vectors[j] ?? [] }));
  }
  return out;
}

async function upsertAll(store: VectorStore, chunks: readonly StoredChunk[]): Promise<void> {
  for (let i = 0; i < chunks.length; i += 500) await store.upsert(chunks.slice(i, i + 500));
}

/**
 * Brings the store in line with the files of `sources` (REQ-KNOW-02/AC4, REQ-KNOW-04/AC1): new and changed files
 * (by content hash) are chunked and replaced, files gone from a source are deleted, unchanged files are left alone.
 * The retrieval mode follows the total size (REQ-KNOW-07); when it changes, or with `rebuild`, every chunk is
 * stored again in the new mode. Embeddings are only computed in hybrid mode, with the configured model, which must
 * match the one the index was built with (REQ-KNOW-08/AC2).
 *
 * @throws {ConfigError} `KNOWLEDGE_EMBEDDING_CHANGED`, `KNOWLEDGE_SOURCE_MISSING`.
 */
export async function syncKnowledge(
  ctx: KnowledgeContext,
  sources: readonly KnowledgeSource[],
  options: { readonly dryRun?: boolean; readonly rebuild?: boolean } = {},
): Promise<SyncReport> {
  const report: SyncReport = {
    added: [],
    updated: [],
    unchanged: [],
    removed: [],
    skipped: [],
    mode: "full",
    chunks: 0,
    rebuilt: false,
  };
  const known = new Map((await ctx.store.files()).map((f) => [f.path, f]));
  const fresh: KnowledgeChunk[] = [];
  const replaced = new Set<string>();
  const mask = (text: string): string => maskCredentials(ctx.maskSecrets(text));
  /** Records one document: unchanged, or chunked (added or updated), or skipped with the reason. */
  const consider = async (
    display: string,
    unchanged: (before: KnowledgeFile) => boolean,
    produce: () => Promise<KnowledgeChunk[] | string>,
  ): Promise<void> => {
    const before = known.get(display);
    if (before && unchanged(before)) {
      report.unchanged.push(display);
      return;
    }
    const chunks = await produce();
    if (typeof chunks === "string") {
      report.skipped.push({ path: display, reason: chunks });
      if (before) {
        replaced.add(display);
        report.removed.push(display);
      }
      return;
    }
    (before ? report.updated : report.added).push(display);
    if (before) replaced.add(display);
    fresh.push(...chunks);
  };
  for (const source of sources) {
    const seen = new Set<string>();
    if (source.kind !== "files") {
      // REQ-KNOW-12: online sources list versions cheaply; only new and changed documents are loaded.
      if (!ctx.documentSource)
        throw new ConfigError(
          "KNOWLEDGE_SOURCE_UNAVAILABLE",
          `Source '${source.name}' needs its online reader.`,
          {},
        );
      const reader = await ctx.documentSource(source);
      for (const doc of await reader.list()) {
        const display = `${source.name}/${doc.id}`;
        const version = `v:${doc.version}`;
        seen.add(display);
        await consider(
          display,
          (before) => before.fileHash === version,
          async () => {
            const loaded = await reader.load(doc);
            return chunksOf(
              { display, rel: `${doc.id}.${loaded.format === "html" ? "html" : "md"}` },
              source,
              Buffer.from(loaded.text, "utf8"),
              doc.modifiedAt,
              mask,
              { version, tags: doc.tags ?? [] },
            );
          },
        );
      }
    } else {
      const files = await scanSource(source, report.skipped);
      if (files === undefined)
        throw new ConfigError(
          "KNOWLEDGE_SOURCE_MISSING",
          `Source '${source.name}' (${source.path}) does not exist; remove it with 'qajitsu knowledge remove ${source.name}'.`,
          {},
        );
      for (const file of files) {
        seen.add(file.display);
        const bytes = await readFile(file.abs);
        await consider(
          file.display,
          (before) => before.fileHash === sha256(bytes),
          async () => chunksOf(file, source, bytes, (await stat(file.abs)).mtime.toISOString(), mask),
        );
      }
    }
    for (const f of known.values())
      if (f.source === source.name && !seen.has(f.path)) {
        replaced.add(f.path);
        report.removed.push(f.path);
      }
  }
  const keptChars = [...known.values()].filter((f) => !replaced.has(f.path)).reduce((n, f) => n + f.chars, 0);
  const chars = keptChars + fresh.reduce((n, c) => n + c.text.length, 0);
  const mode = retrievalMode(chars, ctx.config.full_context_tokens);
  const index = await readKnowledgeIndex(ctx.dir);
  const changed = fresh.length > 0 || replaced.size > 0;
  const rebuild =
    options.rebuild === true ||
    (index !== undefined && index.mode !== mode) ||
    (index === undefined && known.size > 0);
  if (
    !options.rebuild &&
    index?.mode === "hybrid" &&
    mode === "hybrid" &&
    index.embedding !== ctx.config.embedding
  )
    throw new ConfigError(
      "KNOWLEDGE_EMBEDDING_CHANGED",
      `The knowledge base was embedded with ${index.embedding ?? "another model"}; knowledge.embedding is ${ctx.config.embedding}. Run 'qajitsu knowledge reindex'.`,
      {},
    );
  const total = [...known.values()].filter((f) => !replaced.has(f.path)).reduce((n, f) => n + f.chunks, 0);
  Object.assign(report, { mode, chunks: total + fresh.length, rebuilt: rebuild });
  if (options.dryRun === true || (!changed && !rebuild)) return report;

  const embedder = mode === "hybrid" ? await ctx.embedder() : undefined;
  if (embedder && !embedder.local) await ctx.confirmCloud(embedder);
  let dimensions = index?.mode === "hybrid" ? index.dimensions : undefined;
  const store = async (chunks: readonly KnowledgeChunk[]): Promise<void> => {
    const stored: readonly StoredChunk[] = embedder ? await withVectors(chunks, embedder) : chunks;
    dimensions = stored[0]?.vector?.length ?? dimensions;
    await upsertAll(ctx.store, stored);
  };
  if (rebuild) {
    const kept = (await ctx.store.all()).filter(
      (c) => !replaced.has(c.path) && !fresh.some((f) => f.path === c.path),
    );
    await ctx.store.reset();
    await store([...kept, ...fresh]);
  } else {
    await ctx.store.deleteFiles([...replaced]);
    await store(fresh);
  }
  await ctx.store.optimize(ctx.config.index_threshold);
  const next: KnowledgeIndex = {
    schema: 1,
    store: ctx.config.store,
    mode,
    ...(embedder ? { embedding: embedder.id } : {}),
    ...(embedder && dimensions ? { dimensions } : {}),
    chars,
    updated_at: ctx.now().toISOString(),
  };
  await writeKnowledgeIndex(ctx.dir, next);
  return report;
}
