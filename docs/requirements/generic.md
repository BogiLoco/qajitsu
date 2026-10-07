# Generic framework and interfaces (GEN)

QAJitsu plugs into any project through configuration; differences between projects live in adapters and `.qa/`.

### REQ-GEN-01 · Project onboarding through `.qa/`

- Status: implemented
- Priority: must
- Stage: 1
- Related: REQ-CFG-01, REQ-CTX-07

**Acceptance criteria**

- [x] AC1: `.qa/qa.project.yaml` validated by a strict schema (unknown keys rejected) with clear error paths.
- [x] AC2: Folders: `envs/`, `auth/` (login helpers per alias), `hooks/` (seed, setup, teardown), `knowledge/`, `stubs/`.
- [x] AC3: No change to QAJitsu code is needed to onboard a project.

### REQ-GEN-02 · Adapter interfaces

- Status: implemented
- Priority: must
- Stage: 1
- Related: INV-12, ADR-0005

**Acceptance criteria**

- [x] AC1: Interfaces in `@qajitsu/core`: TicketSource, CodeHost, ModelProvider, EnvProvider, SecretProvider, AttemptExecutor (the runner seam, ADR-0005), EvidenceStore, Publisher.
- [x] AC2: Each adapter is a separate package selected by `type` in config through a registry.
- [x] AC3: Each interface has a shared contract test suite.

### REQ-GEN-03 · `init` and `doctor`

- Status: in-progress
- Priority: must
- Stage: 9
- Related: REQ-LLM-03, REQ-CFG-04, REQ-PRJ-02, REQ-CTX-04, REQ-OBS-10

**Acceptance criteria**

- [x] AC1: `qajitsu doctor` checks Node.js and project configuration (stage 1).
- [x] AC2: `doctor` grows with stages: Jira and code host access, Docker, emulators, secrets, model capabilities.
- [x] AC3: `qajitsu init` (basic version in REQ-PRJ-02, stage 2) learns to detect `docker-compose.yml`, repos and test types when creating `.qa/`.
- [ ] AC4: `doctor` prints the versions of QAJitsu, the operating system, Node.js, git, Docker and Compose, Playwright and each installed browser, Java, the Android SDK components and emulator, Appium and its drivers. A tool the project does not need is shown as information; a missing tool the project needs is an error with the command that installs it.
- [ ] AC5: `doctor` shows the versions of the application under test the project knows: for each of its repositories whether the git mirror exists, when it was last updated, the commit of its default branch and the commit of the latest run; with `--online` also whether the remote has newer commits and, for each environment profile with a `version_path`, the version deployed there and whether it matches the commit of the latest run; for a mobile app, where its binary comes from (path, build or CI artifact). A mirror that cannot be read is an error with the fix (`qj clean --project`, then `qj fetch` downloads it again); an environment that does not answer is shown as unknown.

### REQ-GEN-04 · Claude Code plugin interface

- Status: implemented
- Priority: could
- Stage: 9
- Note: accepted on 2026-10-04 by the owner.
- Related: REQ-GEN-05

**Acceptance criteria**

- [x] AC1: The same core exposed as a Claude Code plugin with skills `/qa-plan`, `/qa-run`, `/qa-evidence` for chat-driven use.

### REQ-GEN-05 · Command line

- Status: implemented
- Priority: must
- Stage: 1
- Related: REQ-CI-04

The CLI `qajitsu` (alias `qj`) is the primary interface. Commands arrive with their stages.

**Acceptance criteria**

- [x] AC1: `--version`, `doctor` (stage 1).
- [x] AC2: `fetch` (1); `init`, `use`, `projects`, `plan`, `approve` (2); `run`, `test`, `env check|render|up`, `status`, `note` (3); `evidence`, `logs` (5); `runs`, `resume`, `clean`, `gc`, `work reset` (6); `bench`, `knowledge` (7); `pull` (9).
- [x] AC3: Every command documents its exit codes in `docs/cli/`.
