# 0007. LanceDB is the default knowledge store; Chroma is an adapter

- Status: Accepted
- Date: 2026-10-06
- Related: REQ-KNOW-01, REQ-KNOW-07, REQ-KNOW-08, REQ-KNOW-09, REQ-PRJ-04, ADR-0006

## Context

A project's knowledge base must handle large documentation that changes often (REQ-KNOW-01/AC4): approximate vector
search, keyword search for hybrid retrieval, and upserts and deletes without rebuilding. Candidates checked in their
npm packages:

- **ChromaDB** (`chromadb` 3.x, Apache-2.0): the Node.js client is HTTP-only; the bundled native binaries only run a
  server (`chroma run`). Every project would need a background server process with a port.
- **LanceDB** (`@lancedb/lancedb`, Apache-2.0): an embedded library (Rust core, prebuilt per platform, no install
  scripts) with on-disk vector indexes (IVF-PQ, HNSW), a full-text index, `mergeInsert` upserts, deletes and data
  versions. About 240 MB of native binaries per platform.
- A hand-written flat store: no dependency, but linear search and no real update path at that scale.

## Decision

LanceDB is the default `VectorStore`, one database per project in `<project-home>/knowledge/`. Chroma is an optional
adapter (`knowledge.store: chroma`) for teams that share one Chroma server; its URL and token are `secret://`
references. Both sit behind the same `VectorStore` interface with a shared contract suite. The store lives in its
own adapter package so the core and agents never import it (invariant 12).

## Consequences

- No background process for the knowledge base, locally or in CI; isolation between projects is a directory.
- The install grows by LanceDB's native package; it is an adapter dependency, loaded only by knowledge commands.
- Embeddings come from the models layer (REQ-KNOW-08); the store keeps the embedding model with the index.
