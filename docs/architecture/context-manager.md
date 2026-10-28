# Context manager: implementation plan

Requirements: REQ-CTX-11..18, REQ-LLM-15. Decision: ADR-0014. Status: planned (2026-10-28).

## Where it starts from

- Every role calls `runStructuredAgent({ system, prompt, ... })` in `packages/agents/src/loop.ts`; `prepareCall` in
  `@qajitsu/models` adds the stable prefix and the input limit (REQ-LLM-12). This is the single place to switch.
- Untrusted data: `untrusted(source, text)` with a fixed `<untrusted_data>` tag and `UNTRUSTED_DATA_RULES`
  (`packages/agents/src/context.ts`).
- Profiles: `packages/models/src/capabilities.ts` (`contextWindow`, prices); the limit check in `cost-features.ts`.
- Prompts are recorded with their hashes in the audit trail (REQ-VER-16); `qj reproduce` runs without agents
  (REQ-VER-20).

## Packages

| Package           | Gets                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `@qajitsu/core`   | `ContextFragmentSchema`, `ContextSnapshotSchema`, fragment kinds, trust levels (Zod, no logic)            |
| `@qajitsu/agents` | `ContextManager`: role filter, budget, reductions, layout, compaction, snapshot; role declarations; tools |
| `@qajitsu/models` | context profiles, token counting, renderers per provider (Anthropic, OpenAI-compatible, Google, local)    |
| `@qajitsu/cli`    | snapshots in the run, `qj logs` lines, `qj metrics`, `qj bench --context`, `qj reproduce` rebuild         |

## Phases

Each phase is one branch and pull request, tests first (`/tdd`), `/verify` green, adversarial tests where a role's
view or a status could be affected, then a dogfood run with a local model that compares input tokens and plan quality
with the phase before.

| #   | Scope                                                                                                                                                                                                                                            | Requirements                                           | Done when                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Fragment and snapshot schemas; `ContextManager` with collect, layout and snapshot (no reductions); untrusted blocks with a per-run marker; `runStructuredAgent` takes a context; **triage** and **auditor** migrated                             | CTX-11/AC1+AC2, CTX-12/AC1+AC2, CTX-15, CTX-17/AC1+AC3 | the two roles send the same meaning as before, every call has a snapshot hash in the journal, the injection suite (fake block ends) passes |
| 2   | Role declarations and their enforcement; auditor and judges isolated; remaining roles migrated (analyst, planner, author, healer, approver, explorer, blocked hints, probe); test that refuses prompts built outside the manager                 | CTX-13, CTX-11/AC3                                     | adversarial suite: no forbidden kind reaches a role, also smuggled in text or tool output; no raw prompt string left                       |
| 3   | Context profiles: good working range, answer reserve, token counting (provider endpoint, local estimate with margin per family), renderers per provider with cache breakpoints, compact style for small models                                   | LLM-15                                                 | a fake provider needs only a profile and a renderer; counts recorded with their method                                                     |
| 4   | Budget and reductions: shares per source, duplicates, priority, structure-aware trimming of diffs, logs and recorded traffic (reusing REQ-EVD-09), handles and the `read_context` tool, recorded reductions; replaces the stop of REQ-LLM-12/AC4 | CTX-14, CTX-12/AC3+AC4                                 | a ticket with a diff larger than the window is planned instead of stopped; pinned fragments never touched; `qj logs` shows the reductions  |
| 5   | Compaction of agent loops through the AI SDK's per-step hook, threshold from the budget                                                                                                                                                          | CTX-16                                                 | a long explorer or author loop stays within budget; compactions recorded                                                                   |
| 6   | Summaries by a cheap model, cached by input hash; `qj reproduce` and `qj audit verify` rebuild inputs from snapshots                                                                                                                             | CTX-14/AC2 (summaries), CTX-17/AC2+AC4                 | a repeated run reuses every summary; a changed fragment is named by the rebuild                                                            |
| 7   | Metrics per role and model, `qj bench --context <policies>`                                                                                                                                                                                      | CTX-18                                                 | the demo shop's tickets compared under three policies with quality, cost and time                                                          |

## Risks and how they are handled

- **Meaning changes during migration.** Phase 1 and 2 keep the text each role sends; golden tests of the rendered
  input per role catch any change, which is then made on purpose.
- **Summaries alter facts a check relies on.** Expected values, numbers and quotes are pinned or kept verbatim
  (REQ-CTX-14/AC3); a summary is untrusted data like its source.
- **Determinism.** No time or randomness in the stable part; the run's marker is drawn once and recorded; summaries are
  cached by hash.
- **Cost of counting.** The provider's counting endpoint is used only near the budget; elsewhere the local estimate
  with its margin.
- **Provider lock-in.** The manager never names a provider (INV-11); a test with a fake provider proves a new provider
  needs only a profile and a renderer.
