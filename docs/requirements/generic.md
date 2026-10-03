# Generic framework and interfaces (GEN)

QAJitsu plugs into any project through configuration; differences between projects live in adapters and `.qa/`.

### REQ-GEN-01 · Project onboarding through `.qa/`

- Status: in-progress
- Priority: must
- Stage: 1
- Related: REQ-CFG-01, REQ-CTX-07

**Acceptance criteria**

- [x] AC1: `.qa/qa.project.yaml` validated by a strict schema (unknown keys rejected) with clear error paths.
- [ ] AC2: Folders: `envs/`, `auth/` (login helpers per alias), `hooks/` (seed, setup, teardown), `knowledge/`, `stubs/`.
- [ ] AC3: No change to QAJitsu code is needed to onboard a project.

### REQ-GEN-02 · Adapter interfaces

- Status: in-progress
- Priority: must
- Stage: 1
- Related: INV-12

**Acceptance criteria**

- [x] AC1: Interfaces in `@qajitsu/core`: TicketSource, CodeHost, ModelProvider, EnvProvider, SecretProvider, Runner, EvidenceStore, Publisher.
- [ ] AC2: Each adapter is a separate package selected by `type` in config through a registry.
- [ ] AC3: Each interface has a shared contract test suite.

### REQ-GEN-03 · `init` and `doctor`

- Status: in-progress
- Priority: must
- Stage: 9
- Related: REQ-LLM-03, REQ-CFG-04

**Acceptance criteria**

- [x] AC1: `qajitsu doctor` checks Node.js and project configuration (stage 1).
- [ ] AC2: `doctor` grows with stages: Jira and code host access, Docker, emulators, secrets, model capabilities.
- [ ] AC3: `qajitsu init` creates `.qa/` interactively, detecting `docker-compose.yml`, repos and test types.

### REQ-GEN-04 · Claude Code plugin interface

- Status: proposed
- Priority: could
- Stage: 9
- Related: REQ-GEN-05

**Acceptance criteria**

- [ ] AC1: The same core exposed as a Claude Code plugin with skills `/qa-plan`, `/qa-run`, `/qa-evidence` for chat-driven use.

### REQ-GEN-05 · Command line

- Status: in-progress
- Priority: must
- Stage: 1
- Related: REQ-CI-04

The CLI `qajitsu` (alias `qj`) is the primary interface. Commands arrive with their stages.

**Acceptance criteria**

- [x] AC1: `--version`, `doctor` (stage 1).
- [ ] AC2: `fetch` (1); `plan`, `approve` (2); `run`, `test`, `env check|render|up` (3–6); `evidence`, `logs` (5); `runs`, `resume`, `clean`, `gc` (6); `bench` (7); `init`, `pull` (9).
- [ ] AC3: Every command documents its exit codes in `docs/cli/`.
