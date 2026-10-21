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

- Status: implemented
- Priority: must
- Stage: 1
- Related: REQ-GEN-05

**Acceptance criteria**

- [x] AC1: Requirements catalogue in `docs/requirements/` is the source of truth; ADRs record decisions.
- [x] AC2: TSDoc on every export; API docs generated (TypeDoc) by stage 9.
- [x] AC3: CLI, configuration and adapter reference pages kept in sync with code.

### REQ-NFR-04 · Framework self-test

- Status: implemented
- Priority: must
- Stage: 3
- Related: REQ-LLM-06

**Acceptance criteria**

- [x] AC1: `examples/demo-shop` with seeded bugs behind flags; each must end FAILED, and PASSED without its flag.
- [x] AC2: Adversarial tests block merges.

### REQ-NFR-05 · Security baseline

- Status: implemented
- Priority: must
- Stage: 1
- Related: INV-8, INV-10, REQ-CFG-06

**Acceptance criteria**

- [x] AC1: No secrets in the repository; Claude Code hooks block writing credential-like content and reading `.env` files.
- [x] AC2: Ticket, PR and web content is treated as untrusted data in prompts.
- [x] AC3: Shell execution only with argument arrays; validated identifiers in paths and commands.
- [x] AC4: Dependency review in CI.

### REQ-NFR-06 · Open source and contributor experience

- Status: implemented
- Priority: must
- Stage: 1
- Related: REQ-NFR-03

**Acceptance criteria**

- [x] AC1: Apache-2.0 licence, CONTRIBUTING, SECURITY and code of conduct.
- [x] AC2: A new contributor gets `pnpm install && pnpm verify` green in under five minutes.
- [x] AC3: Demo of the full flow on demo-shop runnable with one command (stage 3).

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

### REQ-NFR-09 · Exploratory pass over every command before a release

- Status: implemented
- Priority: should
- Stage: later
- Related: REQ-NFR-02, REQ-EXEC-25, REQ-PUB-08, REQ-EXEC-17, REQ-CI-01
- Note: accepted by the owner on 2026-10-21; the first pass under it is recorded in `docs/demo/command-pass.md`.

Unit and contract tests did not catch problems that showed up as soon as a person used the commands one after another
(an exploratory pass found more than twenty). `promote`, `regression`, `watch`, `publish` and the `ci` commands were
only touched lightly so far.

**Acceptance criteria**

- [x] AC1: Before a release every command and subcommand is run on the demo shop in a lab with its own HOME (offline, with Docker, with a browser), including `promote`, `regression`, `watch`, `publish` (file and a Jira test instance or fixture), `ci detect`, `ci publish-plan`, `ci comment` and `export`.
- [x] AC2: A checklist in `docs/demo/` lists every command with the date, version and result of its last pass and the defects found; it is updated with each pass.
- [x] AC3: Every defect found gets a regression test that fails without the fix before it is fixed.
- [x] AC4: Flows that can run without a person (promote then regression, `watch` while a run runs, `publish` in file mode, the `ci` commands with fixture events) become part of `pnpm test:e2e`.

### REQ-NFR-10 · A merge needs green CI, on the Node.js version CI uses

- Status: in-progress
- Priority: must
- Stage: later
- Related: REQ-NFR-02, REQ-NFR-05, REQ-NFR-06, REQ-NFR-09
- Note: accepted by the owner on 2026-10-21. CI on GitHub had been red on every pull request and on main since
  2026-10-17 (a Node.js 22 warning in sandboxed tool output, a broken `pnpm demo`, then dev-tool advisories), and
  pull requests were merged anyway; locally everything passed on Node.js 26. AC4 is a repository setting the owner
  enables.

The checks only protect anything if a red result stops a merge and if a contributor's machine runs what CI runs.

**Acceptance criteria**

- [x] AC1: Every pull request and push to main runs `pnpm verify` and the end-to-end suites (`pnpm demo` included) on Linux and macOS with the Node.js version of `.nvmrc`.
- [x] AC2: The same runs every night on main and on demand, so a new runner image, Node.js patch release or advisory shows up without a pull request.
- [x] AC3: `pnpm verify` warns when it runs on another Node.js major than `.nvmrc`, naming how to switch; it does not fail, newer Node.js may work.
- [ ] AC4: main is protected: a pull request merges only when every CI job passed (required status checks, listed in CONTRIBUTING.md).
