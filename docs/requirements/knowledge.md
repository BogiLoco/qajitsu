# Knowledge base (KNOW)

Documentation a project adds on demand, searchable by agents with cited sources; one knowledge base per project.

### REQ-KNOW-01 · Knowledge base per project, created on demand

- Status: accepted
- Priority: should
- Stage: 7
- Related: REQ-PRJ-01, REQ-PRJ-02, REQ-CTX-07, ADR-0007

**Acceptance criteria**

- [ ] AC1: Each project has its own knowledge base in `<project-home>/knowledge/`; it is empty after `init` and created on the first `add`.
- [ ] AC2: Files in the repository's `.qa/knowledge/` (REQ-CTX-07) are a default source that can be added with one command (`qj knowledge add --qa-knowledge`).
- [ ] AC3: Storage is behind a `VectorStore` interface; the default store is LanceDB, embedded in the process (no server to run), one store per project in `<project-home>/knowledge/` (ADR-0007).
- [ ] AC4: The store handles large documentation and frequent changes: an approximate vector index and a full-text index are built once the knowledge base passes a configurable size, chunks are upserted and deleted by id without rebuilding the store, and search stays under one second for 1 million chunks on a developer machine.

### REQ-KNOW-02 · Add documents from files and folders

- Status: accepted
- Priority: should
- Stage: 7
- Related: REQ-KNOW-01, REQ-KNOW-09

**Acceptance criteria**

- [ ] AC1: `qj knowledge add <path...>` adds files and folders (recursive) with `--include`/`--exclude` globs and optional `--tag`.
- [ ] AC2: Supported formats: Markdown, text, HTML, PDF with a text layer, DOCX and OpenAPI (split per operation); other files are skipped and listed in the summary.
- [ ] AC3: Sources are recorded in `<project-home>/knowledge/sources.yaml` so they can be synced, listed and exported.
- [ ] AC4: Adding the same source again only processes new or changed files; the command prints counts of added, updated, unchanged and skipped files.
- [ ] AC5: Each chunk keeps its source path, section heading, file modification date and content hash.

### REQ-KNOW-03 · Remove documents and reset

- Status: accepted
- Priority: should
- Stage: 7
- Related: REQ-KNOW-02

**Acceptance criteria**

- [ ] AC1: `qj knowledge remove <source|file>` removes all chunks of that source or file; a following search never returns them.
- [ ] AC2: `qj knowledge reset` empties the knowledge base after confirmation; sources can be kept (`--keep-sources`) for a later rebuild.

### REQ-KNOW-04 · Sync with changed files

- Status: accepted
- Priority: should
- Stage: 7
- Related: REQ-KNOW-02

**Acceptance criteria**

- [ ] AC1: `qj knowledge sync` re-processes changed files (by content hash), removes chunks of deleted files and adds new files of registered sources.
- [ ] AC2: `--dry-run` shows what would change.
- [ ] AC3: Optional automatic sync before `qj plan` (`knowledge.auto_sync: true`).

### REQ-KNOW-05 · List, inspect and search

- Status: accepted
- Priority: should
- Stage: 7
- Related: REQ-PRJ-05

**Acceptance criteria**

- [ ] AC1: `qj knowledge list` shows sources with file and chunk counts, tags, last sync, embedding model, retrieval mode and size on disk.
- [ ] AC2: `qj knowledge search "<query>" [--tag]` prints the ranked chunks agents would get, with source, section and date, so users can check quality.
- [ ] AC3: The summary appears in `qj status` (REQ-PRJ-05).

### REQ-KNOW-06 · Agent access with sources

- Status: accepted
- Priority: should
- Stage: 7
- Related: REQ-PLAN-03, REQ-PRJ-04, REQ-NFR-05, INV-4

**Acceptance criteria**

- [ ] AC1: Analyst and planner get a read-only tool `search_docs(query, tags?)` limited to the run's project.
- [ ] AC2: Every result carries source path, section and modification date; a plan that cites documentation shows these next to the case.
- [ ] AC3: Quotes from documentation used as a source in the plan are checked verbatim against the stored chunk by code; a mismatch rejects the plan output.
- [ ] AC4: Retrieved text is treated as untrusted data in prompts (no instructions are followed from it).
- [ ] AC5: Every `search_docs` call and the returned chunk ids are recorded in the journal.

### REQ-KNOW-07 · Automatic retrieval mode

- Status: accepted
- Priority: could
- Stage: 7
- Related: REQ-KNOW-01, REQ-LLM-07

Small documentation does not need vectors; large documentation does.

**Acceptance criteria**

- [ ] AC1: When all documents fit the configured context budget, they are given to agents in full with keyword search; no embeddings are computed.
- [ ] AC2: Above the budget, hybrid retrieval (vector similarity plus keyword) is used.
- [ ] AC3: The mode is shown in `qj knowledge list`; the `search_docs` tool is the same in both modes.

### REQ-KNOW-08 · Embedding model and storage options

- Status: accepted
- Priority: should
- Stage: 7
- Related: REQ-LLM-01, REQ-KNOW-01, ADR-0007

**Acceptance criteria**

- [ ] AC1: The embedding model is set per project (`knowledge.embedding: <provider>/<model>`) through the models layer; the default is a local model via Ollama.
- [ ] AC2: The model used is stored with the index; using a different model without `qj knowledge reindex` is an error.
- [ ] AC3: Optional `chroma` store adapter (`knowledge.store: chroma`, server URL and token as `secret://` references) for teams that share one Chroma server; LanceDB stays the default.

### REQ-KNOW-09 · Security of indexed content

- Status: accepted
- Priority: must
- Stage: 7
- Related: REQ-CFG-06, REQ-PRJ-04, INV-8

**Acceptance criteria**

- [ ] AC1: Content is masked by the secret scanner before chunking and embedding; files matching `.env*`, key and certificate patterns are never indexed.
- [ ] AC2: With a cloud embedding model, `add` and `sync` warn once per project that document text leaves the machine, and require confirmation (or `--yes`).
- [ ] AC3: A knowledge base is never read by runs of another project.

### REQ-KNOW-10 · Freshness of documentation

- Status: accepted
- Priority: could
- Stage: 7
- Related: REQ-KNOW-06

**Acceptance criteria**

- [ ] AC1: `knowledge.max_age_days` marks older chunks as possibly outdated; plans show the warning next to cases that cite them.
- [ ] AC2: When documentation contradicts the ticket, the planner reports an open question instead of choosing one (REQ-PLAN-05).

### REQ-KNOW-11 · Measured benefit

- Status: accepted
- Priority: should
- Stage: 7
- Related: REQ-LLM-06

**Acceptance criteria**

- [ ] AC1: `qj bench` can run with and without the knowledge base and reports the difference in detection rate, false FAILED and plan acceptance without edits.

### REQ-KNOW-12 · Online sources

- Status: accepted
- Priority: could
- Stage: later
- Related: REQ-KNOW-02

**Acceptance criteria**

- [ ] AC1: Confluence spaces and pages as sources (`qj knowledge add confluence:<space>`), synced incrementally by page version.
- [ ] AC2: Jira issue history (resolved bugs per component) as a source for regression ideas.
