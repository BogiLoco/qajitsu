# Context manager: implementation plan

Requirements: REQ-CTX-11..19, REQ-LLM-15. Decision: ADR-0014. Status: planned (2026-10-28).

## Principles

The context manager stays, as the one place that assembles, checks and records what a model sees. It manages context
the way a careful engineer would, in this order of preference:

1. **Send what fits as it is.** A call within its budget is not reduced ahead of need (REQ-CTX-14/AC1).
2. **Choose what matters.** Fragments are ranked by relevance to the task, computed by code: what the acceptance
   criteria, the plan's steps and the change name comes first (REQ-CTX-12/AC6).
3. **Start small, read on demand.** Material a role may need is a catalogue of handles with one-line descriptions;
   the agent reads it with tools when it needs it (REQ-CTX-12/AC5, AC4).
4. **Split the task instead of squeezing it.** A change too large for one call is analysed in parts with a clean
   context each (REQ-CTX-19).
5. **Cut by code, keep structure.** Duplicates, then the least relevant into the catalogue, then trimming that keeps
   hunks, signatures, errors and request lines, with the full text behind a handle (REQ-CTX-14/AC2).
6. **Summaries and compaction only as a last resort.** A model summary only when code cannot reach the budget and the
   role cannot read handles; loops are compacted only when the next call would not fit, and then by handles first
   (REQ-CTX-14/AC5, REQ-CTX-16).

What never changes: pinned fragments (approved plan, expectations, rubric) are never reduced; numbers, expected values
and quotes a check relies on are never altered; untrusted data stays in marked blocks; every decision is recorded.

## Where it starts from

- Every role calls `runStructuredAgent({ system, prompt, ... })` in `packages/agents/src/loop.ts`; `prepareCall` in
  `@qajitsu/models` adds the stable prefix and the input limit (REQ-LLM-12). This is the single place to switch.
- Untrusted data: `untrusted(source, text)` with a fixed `<untrusted_data>` tag and `UNTRUSTED_DATA_RULES`
  (`packages/agents/src/context.ts`).
- Profiles: `packages/models/src/capabilities.ts` (`contextWindow`, prices); the limit check in `cost-features.ts`
  stops a call that is too large instead of reducing it.
- The agents already have read-only tools on the worktrees and `search_docs`: the base for reading on demand.

## Packages

| Package           | Gets                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `@qajitsu/core`   | `ContextFragmentSchema`, `ContextSnapshotSchema`, fragment kinds, trust levels (Zod, no logic)               |
| `@qajitsu/agents` | `ContextManager`: role filter, relevance, catalogue and handles, budget, reductions, layout, snapshot; tools |
| `@qajitsu/models` | context profiles, token counting, renderers per provider (Anthropic, OpenAI-compatible, Google, local)       |
| `@qajitsu/cli`    | snapshots in the run, context lines in `qj logs`, `qj metrics`, `qj reproduce` rebuild                       |

## Phases

Each phase is one branch and pull request, tests first (`/tdd`), `/verify` green, adversarial tests where a role's
view could change, then a dogfood run with a local model that compares input tokens, `read_context` calls and plan
quality with the phase before.

| #   | Scope                                                                                                                                                                                                                                      | Requirements                                                       | Done when                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Foundation: fragment and snapshot schemas; `ContextManager` with collect, layout and snapshot; untrusted blocks with a per-run marker; `runStructuredAgent` takes a context; **triage** and **auditor** migrated; context metrics per role | CTX-11/AC1+AC2, CTX-12/AC1+AC2, CTX-15, CTX-17/AC1+AC3, CTX-18/AC1 | the two roles send the same meaning as before; snapshot hash in the journal; injection suite with fake block ends passes |
| 2   | Role isolation and the other roles: declarations enforced, auditor and judges isolated, analyst, planner, author, healer, approver, explorer, blocked hints and probe migrated; no prompt built outside the manager                        | CTX-13, CTX-11/AC3                                                 | adversarial suite: no forbidden kind reaches a role, also smuggled; golden inputs per role unchanged in meaning          |
| 3   | Profiles and renderers: good working range, answer reserve, token counting (provider endpoint, local estimate with margin), renderers with cache breakpoints, compact style for small models                                               | LLM-15                                                             | a fake provider needs only a profile and a renderer; counts recorded with their method                                   |
| 4   | Smart selection: relevance ranking by code, catalogue of handles, `read_context`, start-small layouts per role                                                                                                                             | CTX-12/AC4..AC6                                                    | the planner's input shrinks on the demo tickets with the same plans; reads of handles recorded                           |
| 5   | Budget and code reductions: duplicates, least relevant into the catalogue, structure-aware trimming of diffs, logs and traffic; the stop of REQ-LLM-12/AC4 becomes a reduction                                                             | CTX-14/AC1..AC4, CTX-12/AC3                                        | a diff larger than the window is planned instead of stopped; pinned fragments untouched; `qj logs` shows reductions      |
| 6   | Large changes in parts: split by repository and related files, structured part analyses merged and checked by code                                                                                                                         | CTX-19                                                             | a large change is analysed by a 14B local model in parts with sourced findings; the split is the same in every run       |
| 7   | Last resorts and reproducibility: model summaries under the rules of AC5, cached by input hash; late compaction of loops; `qj reproduce` and `qj audit verify` rebuild inputs from snapshots; `qj bench --context`                         | CTX-14/AC5, CTX-16, CTX-17/AC2+AC4, CTX-18/AC2                     | summaries and compaction happen only when the metrics show code reductions were not enough; rebuilds name changes        |

Metrics come in phase 1 on purpose: every later phase is judged on measured input sizes, reductions and plan quality,
not on assumptions.

## Risks and how they are handled

- **Meaning changes during migration.** Golden tests of the rendered input per role catch any change; changes are made
  on purpose and explained.
- **Relevance ranking hides something the model needed.** Nothing is removed: what ranks low goes to the catalogue as
  a handle the agent can read, and the reads are counted, so a role that keeps reading a handle shows the ranking is
  wrong.
- **Summaries alter facts.** They are the last resort, never applied to pinned fragments or to values a check relies
  on, always with a handle to the full text, and cached so a repeated run sees the same words.
- **Splitting loses connections between parts.** Parts are cut along related files (a handler with its tests and
  routes), the merge is done by code, and the planner keeps handles into the whole change.
- **Determinism.** Fixed sort keys, no time or randomness in the stable part, the run's marker drawn once and recorded.
- **Provider lock-in.** The manager never names a provider (INV-11); a fake provider proves a new one needs only a
  profile and a renderer.
