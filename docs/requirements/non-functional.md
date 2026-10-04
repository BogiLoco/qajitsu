# Non-functional requirements (NFR)

Quality bars for the codebase and the project itself.

### REQ-NFR-01 · Code standards

- Status: implemented
- Priority: must
- Stage: 1
- Related: ADR-0001

**Acceptance criteria**

- [x] AC1: TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESM, Node.js 22+.
- [x] AC2: ESLint (typescript-eslint strict, type-checked) and Prettier enforced in `pnpm verify` and CI.
- [x] AC3: Typed errors, named exports, no `console` in library code, Zod at boundaries.

### REQ-NFR-02 · Test-first and test levels

- Status: implemented
- Priority: must
- Stage: 1
- Related: REQ-NFR-04

**Acceptance criteria**

- [x] AC1: Unit, contract, adversarial and golden tests run in `pnpm verify` without network or real models.
- [x] AC2: Coverage thresholds: 80% overall, 95% for guard, verifier and steps.
- [x] AC3: End-to-end on demo-shop in CI on every PR (stage 3).
- [x] AC4: Test titles reference requirement ids.

### REQ-NFR-03 · Documentation

- Status: in-progress
- Priority: must
- Stage: 1
- Related: REQ-GEN-05

**Acceptance criteria**

- [x] AC1: Requirements catalogue in `docs/requirements/` is the source of truth; ADRs record decisions.
- [x] AC2: TSDoc on every export; API docs generated (TypeDoc) by stage 9.
- [ ] AC3: CLI, configuration and adapter reference pages kept in sync with code.

### REQ-NFR-04 · Framework self-test

- Status: implemented
- Priority: must
- Stage: 3
- Related: REQ-LLM-06

**Acceptance criteria**

- [x] AC1: `examples/demo-shop` with seeded bugs behind flags; each must end FAILED, and PASSED without its flag.
- [x] AC2: Adversarial tests block merges.

### REQ-NFR-05 · Security baseline

- Status: in-progress
- Priority: must
- Stage: 1
- Related: INV-8, INV-10, REQ-CFG-06

**Acceptance criteria**

- [x] AC1: No secrets in the repository; Claude Code hooks block writing credential-like content and reading `.env` files.
- [x] AC2: Ticket, PR and web content is treated as untrusted data in prompts.
- [x] AC3: Shell execution only with argument arrays; validated identifiers in paths and commands.
- [ ] AC4: Dependency review in CI.

### REQ-NFR-06 · Open source and contributor experience

- Status: in-progress
- Priority: must
- Stage: 1
- Related: REQ-NFR-03

**Acceptance criteria**

- [x] AC1: Apache-2.0 licence, CONTRIBUTING, SECURITY and code of conduct.
- [ ] AC2: A new contributor gets `pnpm install && pnpm verify` green in under five minutes.
- [ ] AC3: Demo of the full flow on demo-shop runnable with one command (stage 3).

### REQ-NFR-07 · Platforms

- Status: implemented
- Priority: should
- Stage: 9
- Related: REQ-ENV-06

**Acceptance criteria**

- [x] AC1: Linux and macOS supported; Windows best effort (WSL recommended).
- [x] AC2: CI matrix covers Linux and macOS.

### REQ-NFR-08 · AI-assisted development setup

- Status: implemented
- Priority: should
- Stage: 1
- Related: REQ-NFR-02

**Acceptance criteria**

- [x] AC1: `CLAUDE.md`, rules, subagents, skills and hooks in `.claude/` encode the invariants and workflow.
- [x] AC2: Hook scripts are tested (`pnpm test:hooks`).
- [x] AC3: Agents can trace work to requirement ids (`/requirement` skill, `pnpm req:check`).
