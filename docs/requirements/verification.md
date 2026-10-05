# Verification: fail stays fail (VER)

The layer that keeps results honest. Background: ADR-0002 and the architecture invariants (INV-1..INV-12) in `.claude/rules/architecture-invariants.md`.

### REQ-VER-01 · Status model

- Status: implemented
- Priority: must
- Stage: 1
- Related: INV-1, REQ-CI-04

**Acceptance criteria**

- [x] AC1: Exactly six statuses: PASSED, FAILED, FLAKY, BLOCKED, NOT_RUN, NEEDS_REVIEW, defined in `@qajitsu/core`.
- [x] AC2: Each status has a documented meaning in `docs/architecture/overview.md` and in user docs.
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

- Status: implemented
- Priority: must
- Stage: 1
- Related: INV-2, INV-3

**Acceptance criteria**

- [x] AC1: The guard denies agent writes to `results/`, `evidence/`, `plan/plan.approved.yaml`, `journal/` and `run.json`.
- [x] AC2: The guard denies paths outside the run workspace and tools not allowed for the stage (default deny).
- [x] AC3: The guard wraps every tool call of the agent loop, including MCP tools.

### REQ-VER-04 · Tool-call journal

- Status: implemented
- Priority: must
- Stage: 1
- Related: REQ-OBS-01

**Acceptance criteria**

- [x] AC1: Every allowed and denied tool call is appended to `journal/events.jsonl` with time, run, stage, tool and decision.
- [x] AC2: Tool arguments and result summaries are journaled after masking.

### REQ-VER-05 · Evidence manifest with hashes

- Status: implemented
- Priority: must
- Stage: 3
- Related: INV-7

**Acceptance criteria**

- [x] AC1: Runners write `evidence/manifest.json` with SHA-256, size, case and step for every file.
- [x] AC2: Reports reference evidence by hash; a missing file or hash mismatch fails a publish gate.
- [x] AC3: PASSED requires complete evidence; otherwise NEEDS_REVIEW.

### REQ-VER-06 · Independent auditor

- Status: implemented
- Priority: must
- Stage: 7
- Related: INV-5, REQ-LLM-02

**Acceptance criteria**

- [x] AC1: A separate agent with fresh context receives the approved plan, raw results and evidence (including images).
- [x] AC2: Its findings can only downgrade PASSED to NEEDS_REVIEW.
- [x] AC3: By default the auditor uses a different model than the author.

### REQ-VER-07 · Publish gates

- Status: implemented
- Priority: must
- Stage: 3
- Related: REQ-PLAN-06, REQ-CFG-06, REQ-PUB-01

Nothing leaves the machine unless every gate passes.

**Acceptance criteria**

- [x] AC1: Every approved case has exactly one status; nothing outside the approved plan is reported.
- [x] AC2: The approved plan hash matches.
- [x] AC3: Every PASSED has at least one executed `verify()` and evidence for every step.
- [x] AC4: Every FAILED records expected and actual values and evidence of the failing step.
- [x] AC5: All manifest files exist with matching hashes.
- [x] AC6: Secret scan finds no registered secret value.
- [x] AC7: No gates run means not ok.

### REQ-VER-08 · Computed numbers and validated summary

- Status: implemented
- Priority: must
- Stage: 3
- Related: INV-6

**Acceptance criteria**

- [x] AC1: All counts in matrix, report and comment are computed from structured results.
- [x] AC2: An LLM-written summary is checked: every number equals the computed value and every case id exists with the stated status; otherwise the summary is rejected and a template summary is used.

### REQ-VER-09 · Canary check

- Status: implemented
- Priority: could
- Stage: 7
- Related: REQ-VER-02

**Acceptance criteria**

- [x] AC1: Optionally, one step per run is executed with an inverted expectation; it must fail.
- [x] AC2: If the canary passes, the whole run becomes NEEDS_REVIEW.

### REQ-VER-10 · Human preview before publishing

- Status: implemented
- Priority: must
- Stage: 4
- Related: REQ-PUB-01

**Acceptance criteria**

- [x] AC1: The final matrix and comment are shown for confirmation before publishing (default on).
- [x] AC2: `--auto-publish` or CI configuration may skip the preview; the choice is recorded in `run.json`.

### REQ-VER-11 · Bug fix verification: fails before, passes after

- Status: implemented
- Priority: should
- Stage: later
- Related: INV-1, INV-3, REQ-ENV-03, REQ-CTX-01, REQ-VER-02

For a ticket of type Bug, QAJitsu first reproduces the defect on the version before the fix (the test must fail),
then runs the same test on the version with the fix (it must pass). Strong evidence that the fix works.

**Acceptance criteria**

- [x] AC1: For Bug tickets the plan marks reproduction cases; `qj run --fix-check` runs them on the base commit and on the fix commit, each built from its own worktree.
- [x] AC2: The same approved spec runs on both versions; the spec hash is recorded for both runs.
- [x] AC3: The fix is verified only if the case is FAILED before and PASSED after; any other combination (passed before, failed after, BLOCKED or FLAKY on either side) is reported as not verified with the reason.
- [x] AC4: The report and Jira comment show both results side by side with their evidence.

### REQ-VER-12 · Failure triage hints

- Status: proposed
- Priority: should
- Stage: later
- Related: INV-1, INV-5, INV-6, REQ-VER-06

For every FAILED case an agent suggests the likely cause, to cut noise when reviewing results. The status stays FAILED;
the label is only a hint.

**Acceptance criteria**

- [ ] AC1: Each FAILED case gets a hint: `product-bug`, `test-bug`, `environment` or `data`, with a short justification citing evidence (step, request, screenshot, log).
- [ ] AC2: The hint never changes the status; a hint that cites no existing evidence is dropped.
- [ ] AC3: Matrix, report and Jira comment show the hint visibly as a suggestion, separate from the computed status and counts.
- [ ] AC4: A model error or invalid output leaves the case without a hint; the run continues.
