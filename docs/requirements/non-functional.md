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

### REQ-NFR-11 · Stage timing, budgets and profiling

- Status: in-progress
- Priority: should
- Stage: 5
- Related: REQ-OBS-01, REQ-OBS-03, REQ-LLM-11

Most of a run's time goes to model calls, starting environments and executing tests, not to QAJitsu's own code. Every stage is measured before anything is optimised or rewritten.

- Note: TO BE REVIEWED (2026-10-22): AC5 needs a release workflow and a baseline measured on the CI runner type; a baseline from a developer machine would mislead. The web console views of AC2 and AC4 come with REQ-WEB-01.

**Acceptance criteria**

- [x] AC1: Every pipeline stage and agent step is recorded as a timed span (start, end, waiting time, model or tool used) in the run's journal and exported through OpenTelemetry when configured.
- [x] AC2: `qj status` (and the web console with REQ-WEB-01) shows where the time went per run and per project: model calls, environment, test execution, local processing.
- [x] AC3: Each stage has a configurable time budget with project defaults; exceeding it is a warning with the measured value and never changes a test status.
- [x] AC4: A trend view per stage shows whether runs get faster or slower across releases of QAJitsu and of the project.
- [ ] AC5: A benchmark run on the demo shop measures stage times for every QAJitsu release; a regression beyond a configured tolerance fails the release pipeline.

### REQ-NFR-12 · Pipeline speed by design

- Status: proposed
- Priority: should
- Stage: 6
- Related: REQ-NFR-11, REQ-EXEC-10, REQ-EXEC-19, REQ-PRJ-08, REQ-ENV-03, REQ-LLM-12
- Note: TO BE REVIEWED: parts already exist (git mirrors and the code index cache REQ-PRJ-08, parallel lanes REQ-EXEC-10/19, web sessions per account); mark which criteria are already met before accepting.

The largest gains come from not waiting: independent work runs in parallel, environments and repositories are reused, and tests do not repeat expensive setup.

**Acceptance criteria**

- [ ] AC1: Independent agent calls (for example context gathering, readiness checks and reviewer passes) run in parallel within a configurable concurrency limit; the orchestrator stays deterministic about the order of results.
- [ ] AC2: Repositories are fetched from per-project mirrors with shallow or partial clone and sparse checkout where the analysis allows it.
- [ ] AC3: Environments start from prebuilt images, cached layers or snapshots; warm pools can be configured for workers and test machines.
- [ ] AC4: Web and mobile cases reuse a recorded authenticated state per test account and prepare data through APIs where the plan allows, instead of repeating UI login and setup in every case.
- [ ] AC5: Cases are spread across parallel workers by their measured duration in earlier runs.
- [ ] AC6: Reports reference large evidence files (videos, traces) instead of embedding them, and load them lazily.
- [ ] AC7: Expensive verification modes (mutation check, fix verification, reproduction) run only for changes above a configured risk level or on demand.

### REQ-NFR-13 · Native components for trust-critical and heavy processing

- Status: proposed
- Priority: could
- Stage: 9
- Related: REQ-NFR-11, REQ-VER-15, REQ-VER-21, REQ-CFG-06, INV-2, INV-7, INV-10, ADR-0012
- Note: TO BE REVIEWED: architecture decision (a second language and toolchain); ADR-0012 is only proposed, and the rule is that nothing moves to Rust without measurements from REQ-NFR-11.

TypeScript stays the language of the orchestrator, agents, runners, web console and integrations. A small set of components is written in Rust where it brings a real gain in trust, safety or speed (ADR-0012, proposed).

**Acceptance criteria**

- [ ] AC1: One shared Rust library implements hashing, the Merkle tree, the manifest format, signature checks, streaming masking and secret scanning, and image comparison.
- [ ] AC2: The library is used from Node through native bindings, by the standalone verifier (CLI and WebAssembly) and by the self-hosted worker, so the same code produces and checks evidence.
- [ ] AC3: The TypeScript and Rust implementations of hashing and manifest checks are cross-tested on shared fixtures; any difference fails CI.
- [ ] AC4: Optional separate programs: an egress proxy and sandbox enforcing the allowlist and write bans at operating-system level, and the code-context indexer served over MCP; an existing proxy may be used instead if it passes the same tests.
- [ ] AC5: Native binaries are built for Linux, macOS and Windows on amd64 and arm64, signed, and installable without a Rust toolchain.
- [ ] AC6: Every native component has a pure fallback or a clear error when the binary is missing; a missing native component never weakens a check silently.
