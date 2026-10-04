# Test plan and approval (PLAN)

How the agents turn context into a test plan and how a human approves it before anything executes.

### REQ-PLAN-01 · Change analysis and classification

- Status: implemented
- Priority: must
- Stage: 2
- Related: REQ-CTX-05, REQ-LLM-02

The analyst agent decides what kind of testing the change needs and where the risks are.

**Acceptance criteria**

- [x] AC1: Output `analysis.json`, validated by schema: change type (`api`, `web`, `mobile`, any combination), affected endpoints and screens, regression risks, confidence.
- [x] AC2: Every claim references its source: ticket field, diff file and line, or review comment.
- [x] AC3: Low confidence produces open questions instead of guesses.

### REQ-PLAN-02 · Structured test plan

- Status: implemented
- Priority: must
- Stage: 2
- Related: REQ-PLAN-03, REQ-EXEC-02

The planner writes a plan as YAML validated by a published JSON Schema, plus a readable Markdown rendering.

**Acceptance criteria**

- [x] AC1: Each case has `id`, `title`, `type` (api/web/mobile), `priority`, `source`, `preconditions`, test data as aliases, `steps[]` (each with `id`, `action`, `expect`) and required `evidence`.
- [x] AC2: Expected results are structured where possible (status codes, fields, UI texts) so `plan.expect()` can read them.
- [x] AC3: The plan contains `open_questions` and `out_of_scope` sections.
- [x] AC4: Versions are kept as `plan.vN.yaml` and `plan.vN.md`.

### REQ-PLAN-03 · Grounded sources

- Status: implemented
- Priority: must
- Stage: 2
- Related: REQ-VER-07, INV-1

Every case must be traceable to something real, which blocks invented requirements.

**Acceptance criteria**

- [x] AC1: `source` is one of: an acceptance criterion id, a verbatim quote from the ticket snapshot, or a file (and line range) from the diff.
- [x] AC2: Quotes are checked verbatim against the snapshot; diff references are checked against the diff. Failures reject the plan with the offending cases listed.

### REQ-PLAN-04 · Human review loop

- Status: implemented
- Priority: must
- Stage: 2
- Related: REQ-PLAN-06, REQ-PLAN-07

The user reviews the plan and approves it, revises it in words, edits the file, or aborts, as many rounds as needed.

**Acceptance criteria**

- [x] AC1: Terminal prompt with: accept, revise (free-text instruction), edit (opens `$EDITOR`), quit.
- [x] AC2: A revision produces a new version and shows the diff: added, removed and changed cases.
- [x] AC3: Manual edits are schema-validated and re-run through the source check before approval.

### REQ-PLAN-05 · Open questions instead of guessing

- Status: implemented
- Priority: must
- Stage: 2
- Related: REQ-PLAN-01

When the ticket is unclear, the planner asks instead of assuming.

**Acceptance criteria**

- [x] AC1: Unresolved questions are listed in `open_questions`.
- [x] AC2: Approving a plan with open questions requires explicit confirmation, recorded in `run.json`.

### REQ-PLAN-06 · Plan freeze

- Status: implemented
- Priority: must
- Stage: 2
- Related: INV-3, REQ-VER-07

Approval freezes the plan; only approved cases can execute.

**Acceptance criteria**

- [x] AC1: Approval writes `plan/plan.approved.yaml` with SHA-256, approver and time in `run.json`.
- [x] AC2: The approved plan is read-only to agents (guard).
- [x] AC3: A hash mismatch before execution or publishing blocks the run.
- [x] AC4: Specs for cases not in the approved plan are not executed and are reported.

### REQ-PLAN-07 · Approval channels

- Status: in-progress
- Priority: should
- Stage: 10
- Related: REQ-CI-03

Besides the terminal, plans can be approved where the team already works.

**Acceptance criteria**

- [x] AC1: Terminal approval (stage 2).
- [x] AC2: In CI: plan posted to the PR/MR and Jira; approval via protected environment (GitHub), manual job (GitLab) or `/qa approve` comment; `/qa revise <text>` triggers a new version.
- [ ] AC3: Later: approval in Jira by comment and in a small web UI.
- [x] AC4: New plans are never approved automatically.
