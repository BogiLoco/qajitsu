---
name: docs-and-adr
description: How QAJitsu documents itself - TSDoc conventions, docs/ page structure, and Architecture Decision Records. Use when writing an ADR, a docs page, or TSDoc for public API.
argument-hint: "[adr <title> | docs <topic>]"
---

# Documentation in QAJitsu

## Where things live

| What                                            | Where                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| Requirements (source of truth)                  | `docs/requirements/<area>.md`, edited with the `/requirement` skill |
| Roadmap, status                                 | `docs/roadmap.md`, `docs/STATUS.md`                                 |
| Architecture overview, glossary                 | `docs/architecture/overview.md`, `docs/glossary.md`                 |
| Background plan (Polish)                        | `docs/plan.md`                                                      |
| Decisions                                       | `docs/adr/NNNN-kebab-title.md`                                      |
| CLI reference                                   | `docs/cli/<command>.md`                                             |
| Config reference                                | `docs/config/*.md` (field tables generated from Zod)                |
| Adapters                                        | `docs/adapters/<kind>-<name>.md`                                    |
| Guides (getting started, CI/CD, writing `.qa/`) | `docs/guides/*.md`                                                  |
| API reference                                   | generated from TSDoc by TypeDoc (`pnpm run docs`)                   |

## Writing an ADR (`/docs-and-adr adr <title>`)

1. Next number: highest in `docs/adr/` plus one, four digits.
2. Copy [adr-template.md](adr-template.md). Status starts as `Proposed`; the user changes it to `Accepted`.
3. Fill `Related:` with requirement ids (`REQ-...`), invariants (`INV-n`) and ADRs.
4. Keep it to one page: context, decision, alternatives with why not, consequences (good and bad).
5. Link the ADR from code comments only where the decision is non-obvious.
6. Superseding: new ADR says `Supersedes NNNN`; old one gets `Superseded by MMMM`. Never rewrite an accepted ADR.

## Docs pages

- Lead with what the reader can do after reading, then the steps.
- Every command and config key shown must exist in the code; copy from the schema, do not retype.
- Examples use demo-shop and fictional data only.

## TSDoc

Summary sentence, `@param`, `@returns`, `@throws`, `@example` (compiling) on entry points, `@remarks` for non-obvious behaviour, `@see` for the ADR. Mark unstable API with `@experimental`.
