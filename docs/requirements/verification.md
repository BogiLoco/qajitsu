# Verification: fail stays fail (VER)

The layer that keeps results honest. Background: ADR-0002 and the architecture invariants (INV-1..INV-12) in `.claude/rules/architecture-invariants.md`.

### REQ-VER-01 · Status model

- Status: in-progress
- Priority: must
- Stage: 1
- Related: INV-1, REQ-CI-04

**Acceptance criteria**

- [x] AC1: Exactly six statuses: PASSED, FAILED, FLAKY, BLOCKED, NOT_RUN, NEEDS_REVIEW, defined in `@qajitsu/core`.
- [ ] AC2: Each status has a documented meaning in `docs/architecture/overview.md` and in user docs.
- [x] AC3: Adding or changing a status requires an ADR (breaking change).

### REQ-VER-02 · Verdict from runner output only

- Status: implemented
- Priority: must
- Stage: 3
- Related: INV-1, ADR-0002

**Acceptance criteria**

- [x] AC1: Statuses are computed only by `computeStatus` in `@qajitsu/verifier` from runner attempts and assertions.
- [x] AC2: No agent has a tool that sets or changes a status.
- [x] AC3: A runner claiming "passed" while an assertion failed yields FAILED; "passed" without assertions never yields PASSED.

### REQ-VER-03 · Write bans for agents

- Status: in-progress
- Priority: must
- Stage: 1
- Related: INV-2, INV-3

**Acceptance criteria**

- [x] AC1: The guard denies agent writes to `results/`, `evidence/`, `plan/plan.approved.yaml`, `journal/` and `run.json`.
- [x] AC2: The guard denies paths outside the run workspace and tools not allowed for the stage (default deny).
- [ ] AC3: The guard wraps every tool call of the agent loop, including MCP tools.

### REQ-VER-04 · Tool-call journal

- Status: in-progress
- Priority: must
- Stage: 1
- Related: REQ-OBS-01

**Acceptance criteria**

- [x] AC1: Every allowed and denied tool call is appended to `journal/events.jsonl` with time, run, stage, tool and decision.
- [ ] AC2: Tool arguments and result summaries are journaled after masking.

### REQ-VER-05 · Evidence manifest with hashes

- Status: in-progress
- Priority: must
- Stage: 3
- Related: INV-7

**Acceptance criteria**

- [ ] AC1: Runners write `evidence/manifest.json` with SHA-256, size, case and step for every file.
- [ ] AC2: Reports reference evidence by hash; a missing file or hash mismatch fails a publish gate.
- [x] AC3: PASSED requires complete evidence; otherwise NEEDS_REVIEW.

### REQ-VER-06 · Independent auditor

- Status: in-progress
- Priority: must
- Stage: 7
- Related: INV-5, REQ-LLM-02

**Acceptance criteria**

- [ ] AC1: A separate agent with fresh context receives the approved plan, raw results and evidence (including images).
- [x] AC2: Its findings can only downgrade PASSED to NEEDS_REVIEW.
- [ ] AC3: By default the auditor uses a different model than the author.

### REQ-VER-07 · Publish gates

- Status: in-progress
- Priority: must
- Stage: 3
- Related: REQ-PLAN-06, REQ-CFG-06, REQ-PUB-01

Nothing leaves the machine unless every gate passes.

**Acceptance criteria**

- [x] AC1: Every approved case has exactly one status; nothing outside the approved plan is reported.
- [x] AC2: The approved plan hash matches.
- [ ] AC3: Every PASSED has at least one executed `verify()` and evidence for every step.
- [ ] AC4: Every FAILED records expected and actual values and evidence of the failing step.
- [ ] AC5: All manifest files exist with matching hashes.
- [ ] AC6: Secret scan finds no registered secret value.
- [x] AC7: No gates run means not ok.

### REQ-VER-08 · Computed numbers and validated summary

- Status: in-progress
- Priority: must
- Stage: 3
- Related: INV-6

**Acceptance criteria**

- [x] AC1: All counts in matrix, report and comment are computed from structured results.
- [ ] AC2: An LLM-written summary is checked: every number equals the computed value and every case id exists with the stated status; otherwise the summary is rejected and a template summary is used.

### REQ-VER-09 · Canary check

- Status: accepted
- Priority: could
- Stage: 7
- Related: REQ-VER-02

**Acceptance criteria**

- [ ] AC1: Optionally, one step per run is executed with an inverted expectation; it must fail.
- [ ] AC2: If the canary passes, the whole run becomes NEEDS_REVIEW.

### REQ-VER-10 · Human preview before publishing

- Status: accepted
- Priority: must
- Stage: 4
- Related: REQ-PUB-01

**Acceptance criteria**

- [ ] AC1: The final matrix and comment are shown for confirmation before publishing (default on).
- [ ] AC2: `--auto-publish` or CI configuration may skip the preview; the choice is recorded in `run.json`.
