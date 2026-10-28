# ADR-0014: Context manager

- Status: accepted
- Date: 2026-10-28
- Related: INV-1, INV-5, INV-8, INV-11, REQ-CTX-05, REQ-CTX-11..18, REQ-LLM-03, REQ-LLM-12, REQ-LLM-15, REQ-VER-16,
  REQ-VER-20

## Context

Each agent role builds its prompt from strings: role instructions, the ticket, the diff, files, knowledge, tool
results. Pieces of the same job live in several places: `untrusted()` and a fixed tag in `@qajitsu/agents`, the stable
prefix and the input limit in `@qajitsu/models` (REQ-LLM-12), the capability profile (REQ-LLM-03), the audit trail of
prompts (REQ-VER-16). What is missing is one place that decides what a role sees, what is cut when the input is too
large, and how the same input is rebuilt later. Today a call over its limit is stopped, not reduced; a role could be
handed text of another role by mistake; a ticket that knows the data tag can imitate its end; and the order of
pieces is decided per role, so caching and reproducibility depend on each prompt's author.

## Decision

1. **One unit: the fragment.** Everything a model can see is a fragment with kind, source, trust level, priority,
   `pinned` flag, token count and SHA-256 (`@qajitsu/core`, Zod).
2. **One pipeline, in a fixed order** (`ContextManager` in `@qajitsu/agents`): collect → role filter → budget →
   reduce → lay out → render → snapshot. The manager works on a neutral description and knows no provider or model
   by name (INV-11).
3. **Roles see what their declaration allows.** The declaration is code, reviewed like the guard. The auditor and any
   judge never see reasoning or transcripts of the roles they judge (INV-1, INV-5).
4. **Reduction from the cheapest, always recorded:** duplicates, low priority, structure-aware trimming, a summary by
   a cheap model, a handle the agent can read through a read-only tool. Pinned fragments are never reduced; a context
   that cannot fit them stops the call.
5. **Untrusted data in blocks bounded by a marker drawn per run,** so content cannot close its block.
6. **Determinism:** fixed sort keys, no time or randomness in the stable part, summaries cached by input hash, and a
   snapshot (fragment hashes, reductions, marker, renderer and profile versions) whose hash goes to the journal.
   `qj reproduce` rebuilds the same input.
7. **Models adapt through profiles and renderers** in `@qajitsu/models`: good working range, token counting method,
   cache style, message format, compact style for small models. A new model is a profile; a new provider is a
   renderer.

## Consequences

- Prompts of every role move into fragment builders; the migration is per role, with a test that refuses prompt
  strings assembled outside the manager once all roles have moved.
- `untrusted()` and `UNTRUSTED_DATA_RULES` become the renderer's block form; their tag is replaced by the run's marker.
- The input limit of REQ-LLM-12/AC4 becomes the budget of REQ-CTX-14: reduce first, stop only when pinned fragments do
  not fit.
- The audit trail gains one snapshot per call; certificates cover it through the journal.
- Summaries add model calls; they are cached and their cost is attributed to the role that needed them.
