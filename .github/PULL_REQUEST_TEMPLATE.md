## What and why

<!-- One or two sentences. Link the roadmap stage or issue. -->

## Requirements

<!-- Ids from docs/requirements/ this PR implements or changes, with criteria ticked in this PR. -->

- Refs: REQ-

- [ ] Acceptance criteria ticked only where implemented **and** tested; `pnpm req:index` run.

## Test evidence

<!-- Commands run and their result. New tests are titled with the requirement id (REQ-X-NN/ACk). -->

- [ ] `pnpm verify` green locally

## Invariants

- [ ] This change does not touch status, results, evidence, guard, gates or publishing
- [ ] It does, and I added or updated adversarial tests (`tests/adversarial`); invariants affected: INV-

## Checklist

- [ ] TSDoc for changed public API
- [ ] Changeset added (`pnpm changeset`) for user-visible changes
- [ ] Docs updated (requirements, ADR if a decision was made)
- [ ] No secrets, real company data or unscrubbed fixtures
