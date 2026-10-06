/** A piece of a project document, as stored and returned to agents (REQ-KNOW-02/AC5, REQ-KNOW-06/AC2). */
export interface KnowledgeChunk {
  /** Stable id: `<file id>-<ordinal>`; cited by plans and recorded in the journal. */
  readonly id: string;
  /** Name of the source in `sources.yaml` the file came from. */
  readonly source: string;
  /** Path of the file as shown to people: relative to the source root, prefixed by the source name. */
  readonly path: string;
  /** Section heading path, e.g. `Orders > Cancel an order`; empty for documents without headings. */
  readonly section: string;
  /** Modification date of the file, ISO 8601. */
  readonly modifiedAt: string;
  /** SHA-256 of the whole file content; unchanged files are skipped by `add` and `sync` (REQ-KNOW-02/AC4). */
  readonly fileHash: string;
  /** SHA-256 of the chunk text. */
  readonly hash: string;
  readonly tags: readonly string[];
  /** Masked text of the chunk (REQ-KNOW-09/AC1). */
  readonly text: string;
}

/** A chunk with its embedding; hybrid stores need one per chunk, full-text-only stores none (REQ-KNOW-07). */
export interface StoredChunk extends KnowledgeChunk {
  readonly vector?: readonly number[];
}

/** One file of the knowledge base with the hash it was indexed at. */
export interface KnowledgeFile {
  readonly path: string;
  readonly source: string;
  readonly fileHash: string;
  readonly chunks: number;
  /** Characters of all its chunks; decides the retrieval mode without reading the text (REQ-KNOW-07). */
  readonly chars: number;
}

/** A ranked search result. Higher scores rank first; scores are only comparable within one search. */
export interface KnowledgeHit {
  readonly chunk: KnowledgeChunk;
  readonly score: number;
}

/** A search: keyword only without `vector`, hybrid (vector plus keyword) with it. */
export interface KnowledgeQuery {
  readonly text: string;
  readonly vector?: readonly number[];
  /** Only chunks with at least one of these tags. */
  readonly tags?: readonly string[];
  readonly limit: number;
}

/**
 * Storage of one project's knowledge base (REQ-KNOW-01/AC3, ADR-0007). One store per project; implementations never
 * read or write outside the location they were created for (REQ-KNOW-09/AC3). Chunks are replaced per file, so
 * updates never rebuild the store (REQ-KNOW-01/AC4).
 */
export interface VectorStore {
  /** Inserts chunks or replaces chunks with the same id. Either every chunk has a vector or none has. */
  upsert(chunks: readonly StoredChunk[]): Promise<void>;
  /** Deletes every chunk of these files; returns how many were deleted. */
  deleteFiles(paths: readonly string[]): Promise<number>;
  /** Files in the store with their indexed hash and chunk count. */
  files(): Promise<readonly KnowledgeFile[]>;
  /** Ranked chunks for a query. */
  search(query: KnowledgeQuery): Promise<readonly KnowledgeHit[]>;
  /** Chunks by id, in the order of `ids`; unknown ids are left out. */
  get(ids: readonly string[]): Promise<readonly KnowledgeChunk[]>;
  /** Every chunk, by path and id; for documentation small enough to be used in full (REQ-KNOW-07/AC1). */
  all(): Promise<readonly KnowledgeChunk[]>;
  count(): Promise<number>;
  /** Builds or updates indexes once the store has at least `threshold` chunks (REQ-KNOW-01/AC4). */
  optimize(threshold: number): Promise<void>;
  /** Deletes every chunk. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** An embedding model from the models layer (REQ-KNOW-08/AC1). */
export interface Embedder {
  /** `<provider>/<model>`; stored with the index (REQ-KNOW-08/AC2). */
  readonly id: string;
  /** False when document text leaves the machine (REQ-KNOW-09/AC2). */
  readonly local: boolean;
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** A document of an online source: a Confluence page or a Jira issue (REQ-KNOW-12). */
export interface RemoteDocument {
  /** Stable id inside the source, e.g. a page id or an issue key. */
  readonly id: string;
  readonly title: string;
  /** Changes whenever the content changes (page version, issue update time); unchanged documents are not loaded. */
  readonly version: string;
  /** ISO 8601. */
  readonly modifiedAt: string;
  readonly tags?: readonly string[];
}

/**
 * An online source of documents for the knowledge base (REQ-KNOW-12): listing is cheap and carries versions, so a
 * sync loads only new and changed documents. Content is untrusted data, masked before it is stored.
 */
export interface DocumentSource {
  list(signal?: AbortSignal): Promise<readonly RemoteDocument[]>;
  load(
    document: RemoteDocument,
    signal?: AbortSignal,
  ): Promise<{ readonly format: "html" | "markdown"; readonly text: string }>;
}
