---
name: verify
description: Run QAJitsu's full local verification before claiming work is done or committing - typecheck, lint, format, all tests with coverage, hook tests and the requirements check, plus a self-check of requirement traceability, docs, changeset and invariants. Use before every commit and at the end of every task.
allowed-tools: Bash(pnpm verify) Bash(pnpm verify *) Bash(pnpm test:adversarial) Bash(pnpm req:check) Bash(pnpm req:index) Bash(git status *) Bash(git diff *)
---

# /verify

## 1. Run the checks

Run `pnpm verify` from the repo root. It runs, in order: `typecheck`, `lint`, `format:check`, `test:coverage` (unit, contract, adversarial, golden and script tests with coverage thresholds), `test:hooks` (Claude Code hook scripts) and `req:check` (requirements catalogue, index and roadmap lists).

If only `req:check` fails because the index is stale, run `pnpm req:index` and re-run. Formatting failures: `pnpm format`.

If `pnpm verify` does not exist yet (early skeleton), run what exists among `pnpm typecheck`, `pnpm lint`, `pnpm test` and say which checks were unavailable. Never report a check as passed if you did not run it.

## 2. On failure

Fix the cause and re-run. If the fix is not obvious after one attempt, delegate to the `build-error-resolver` agent. Never skip, weaken or delete a test to pass.

## 3. Self-check the change (`git diff` against the base branch)

- [ ] The change maps to requirement ids in `docs/requirements/`; work without a requirement got one (`/requirement`).
- [ ] Every behaviour change has a test that fails without it, titled with the criterion id (`REQ-X-NN/ACk: ...`).
- [ ] Acceptance criteria are ticked only where implemented and tested; statuses updated (`in-progress` / `implemented`).
- [ ] New or changed exports have TSDoc.
- [ ] CLI, config or status changes are reflected in `docs/`.
- [ ] A changeset exists for user-visible changes.
- [ ] No `console.*`, `any`, `@ts-ignore`, `.only`, `.skip` added in `packages/**/src`.
- [ ] No secrets or real company data in code, fixtures or docs.
- [ ] If guard, verifier, steps, status or report code changed: adversarial test added and `verification-auditor` consulted.

## 4. Report

Print a short block:

```
verify: PASS | FAIL
checks: typecheck ✔ lint ✔ format ✔ tests+coverage ✔ hooks ✔ requirements ✔   (✘ for failed, – for unavailable)
requirements: REQ-... (criteria ticked in this change: REQ-X-NN/ACk, ...)
self-check: all ✔ | missing: <items>
```
