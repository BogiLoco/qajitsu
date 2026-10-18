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

- Status: deferred
- Priority: should
- Stage: 10
- Related: REQ-CI-03

Deferred: AC3 (approval by Jira comment and a small web UI) is parked; terminal and CI approval work.

Besides the terminal, plans can be approved where the team already works.

**Acceptance criteria**

- [x] AC1: Terminal approval (stage 2).
- [x] AC2: In CI: plan posted to the PR/MR and Jira; approval via protected environment (GitHub), manual job (GitLab) or `/qa approve` comment; `/qa revise <text>` triggers a new version.
- [ ] AC3: Later: approval in Jira by comment and in a small web UI.
- [x] AC4: New plans are never approved automatically.

### REQ-PLAN-08 · Test depth and budget

- Status: implemented
- Priority: should
- Stage: later
- Related: REQ-PLAN-02, REQ-LLM-07, REQ-CI-05

**Acceptance criteria**

- [x] AC1: `qj plan --depth smoke|standard|full` selects cases by risk; the plan records the depth and why each case is in or out.
- [x] AC2: Before a run QAJitsu shows an estimate of time and model cost based on case count, types and past runs.
- [x] AC3: A configured budget (time or cost) stops further cases when reached; cases not run are NOT_RUN with the reason.

### REQ-PLAN-09 · Concrete expected values

- Status: implemented
- Priority: must
- Stage: 2
- Related: INV-4, REQ-PLAN-02, REQ-PLAN-04, REQ-PLAN-06, REQ-EXEC-04

An expected value in a plan is a value a test can compare with, never a name standing in for one, and a selector in a
plan points to an element that exists in the code under test.

**Acceptance criteria**

- [x] AC1: Before a plan version is shown for review, code checks every expected value and flags placeholders: `<...>`, `{...}`, `${...}`, TBD, TODO, `?`, `...`, N/A, and lower-case identifiers such as `expected_total`, `reduced_value` or `original_total` (words joined by `_` with a word like value, expected, result, original, final or computed). Codes such as `DISCOUNT_NOT_FOUND` are not flagged.
- [x] AC2: When the project has an OpenAPI document, an expected field whose type does not match the response schema (e.g. a string for a numeric `total`) is flagged too.
- [x] AC3: Flagged values go back to the planner once for an automatic revision; whatever is still flagged is listed in the review next to the plan (case, step, field, value, why).
- [x] AC4: A plan with flagged values cannot be approved without `--confirm-placeholders` (or the same answer in the interactive review); the confirmation and the flagged values are recorded in `run.json`.
- [x] AC5: The check is deterministic code with fixture tests, including values that must not be flagged.
- [x] AC6: A step that is not manual and whose expect has only a description (no status, fields, texts, elements, message or visual) is flagged the same way: the test would have nothing to compare.
- [x] AC7: The planner and the author get a selector inventory computed by code from the worktree of the run: every `data-testid` (and the mobile equivalents, e.g. Android resource ids) with the file and the page or screen it belongs to, so a model does not have to search for them.
- [x] AC8: Every `testid:` selector in a plan must exist in that inventory for the run's commit; an unknown one is flagged like a placeholder (one automatic revision, then listed in the review), never silently accepted.
- [x] AC9: When the OpenAPI document says an endpoint answers 401 to a caller who is not logged in, an api case that calls it names a test account (`data.user`, e.g. `user:standard`) or expects the 401 itself; otherwise the step is flagged like an unknown field, before anyone approves a plan whose every call would fail for want of a login.

### REQ-PLAN-10 · Approval by a person or by models, auditable

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-PLAN-04, REQ-PLAN-06, REQ-PLAN-07, REQ-CI-03, REQ-OBS-01, REQ-GEN-07, INV-1, INV-3, INV-5
- Note: TO BE REVIEWED (owner, 2026-10-16): wanted as a direction (a Jira flow that a person or models can pass), to be thought through before accepting. It changes REQ-PLAN-07/AC4 ("never approved automatically") and needs its own ADR, because the approved plan is where expected values come from.

A plan can pass an approval flow where each step is a person or a model, for example in Jira, so a team can automate
QA end to end where it accepts the risk. Every approval, by whom or by what, is recorded so the testing passes an audit.

**Acceptance criteria**

- [ ] AC1: The project configures an approval flow of one or more steps; each step is a person (as today) or a model approver, and a model approver is off unless switched on explicitly.
- [ ] AC2: A model approver uses a different model from the planner and checks the plan against the ticket, sources and plan checks; it can approve, ask for a revision with reasons, or hand over to a person, and its answer is validated like any agent output.
- [ ] AC3: Every approval is recorded in `run.json` and the journal hash chain: approver kind (person or model), identity (name, or provider, model id and version), time, the SHA-256 of the approved plan, and for a model the SHA-256 of its prompt and answer.
- [ ] AC4: The same flow can run in Jira: the plan is posted, each step's decision is a transition or comment by a person or by QAJitsu for a model step, and the hashes of the plan and of each decision are written with it.
- [ ] AC5: Results of a plan without a human approval are marked as such in the matrix, report, junit and Jira comment, and their PASSED results are NEEDS_REVIEW unless the project explicitly accepts model-only approval.
- [ ] AC6: `qj audit verify` checks the approval records against the journal and the approved plan; any mismatch fails the audit and the publish gates.

### REQ-PLAN-11 · Exploration before planning, accepted by a person

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-EXEC-15, REQ-EXEC-24, REQ-EXEC-25, REQ-PLAN-03, REQ-PLAN-04, REQ-PLAN-05, REQ-PLAN-06, REQ-KNOW-01, INV-3, INV-4
- Note: TO BE REVIEWED (owner, 2026-10-17): the flow is wanted (explore first, then plan from what a person accepted); the review command, the knowledge hand-over (AC8) and the shape of the plan source are to be confirmed before accepting.

Exploratory sessions run before the plan: browser, mobile or command-line, on the ticket's change. A person reviews
what they found and accepts or rejects each observation, finding and not-done checklist item. The planner then sees
only what the person accepted and may propose cases from it, each citing its source; the plan is still reviewed and
approved as usual. Exploration says what is worth testing; it never says what the right result is.

**Acceptance criteria**

- [ ] AC1: `qj explore review <TICKET> [--session S01]` lists every observation (`O1`), finding (`F1`) and not-done checklist item (`C3`) of the run's sessions with their actions and evidence, and records for each one accepted or rejected, by whom, when and an optional note; `--accept O1,F2` and `--reject O3` do the same without prompts (CI, scripts). Nothing is accepted by default and an agent cannot accept.
- [ ] AC2: Every decision is journaled with the person and the SHA-256 of the session's `session.json`; if the session file changes after a decision, the decision no longer counts and the item must be reviewed again.
- [ ] AC3: `qj plan` gives the planner the accepted items of the run's sessions (title, kind, what was seen, the steps as recorded actions) as untrusted data; rejected and unreviewed items never reach it, and the plan review says how many accepted items were offered.
- [ ] AC4: A case proposed from exploration cites its source (`explore:S01/O2`); code rejects a citation of an item that does not exist, is not accepted, or belongs to another run.
- [ ] AC5: Expected values of such a case come from the ticket, the documentation, an imported case or the person, cited as usual (REQ-PLAN-03, REQ-PLAN-09); what the application did during exploration is never an expected value. A case without such a source becomes an open question (REQ-PLAN-05), never an expectation copied from the observation.
- [ ] AC6: An accepted not-done checklist item becomes a proposed case or an open question; the plan review lists those it covers and those it does not, so a gap left by exploration stays visible.
- [ ] AC7: The plan review marks cases from exploration with their source and links to the session report; the plan is approved and frozen as any other (REQ-PLAN-04, REQ-PLAN-06); nothing from exploration runs before that.
- [ ] AC8: An accepted observation can be kept in the project's knowledge base as known behaviour of the area it concerns (`qj explore review --keep O1`), so planners of later tickets touching that area see it, cited and checked like any other document.
