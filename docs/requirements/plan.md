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
- [x] AC4: New plans are never approved automatically unless the project configures a model step in its approval flow (REQ-PLAN-10, ADR-0010).

### REQ-PLAN-08 · Test depth and budget

- Status: implemented
- Priority: should
- Stage: later
- Related: REQ-PLAN-02, REQ-LLM-07, REQ-CI-05

**Acceptance criteria**

- [x] AC1: `qj plan --depth smoke|standard|full` selects cases by risk; the plan records the depth and why each case is in or out.
- [x] AC2: Before a run QAJitsu shows an estimate of time and model cost based on case count, types and past runs.
- [x] AC3: A configured budget (time or cost) stops further cases when reached; cases not run are NOT_RUN with the reason.
- [x] AC4: The estimate before a run counts only the cases that will run: with `--cases`, the others are left out of the executions, time and tokens it shows.

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

- Status: implemented
- Priority: could
- Stage: later
- Related: REQ-PLAN-04, REQ-PLAN-06, REQ-PLAN-07, REQ-CI-03, REQ-OBS-01, REQ-OBS-05, REQ-GEN-07, ADR-0010, INV-1, INV-3, INV-5
- Note: accepted by the owner on 2026-10-18 (ADR-0010) and implemented: `approval.flow` of person and model steps, the approver role, `qj approve --person`, records in `run.json` (`approvals`) and the journal (`approval.step`), the `approval-intact` gate and `qj audit verify`, `approval.model_only`, and Jira comments per decision. Jira transitions are left for later.

A plan can pass an approval flow where each step is a person or a model, for example in Jira, so a team can automate
QA end to end where it accepts the risk. Every approval, by whom or by what, is recorded so the testing passes an audit.

**Acceptance criteria**

- [x] AC1: The project configures an approval flow of one or more steps; each step is a person (as today) or a model approver, and a model approver is off unless switched on explicitly.
- [x] AC2: A model approver uses a different model from the planner and checks the plan against the ticket, sources and plan checks; it can approve, ask for a revision with reasons, or hand over to a person, and its answer is validated like any agent output. Code decides first: a plan with flagged expectations or open questions goes to a person without asking the model.
- [x] AC3: Every approval is recorded in `run.json` and the journal hash chain: approver kind (person or model), identity (name, or provider, model id and version), time, the SHA-256 of the approved plan, and for a model the SHA-256 of its prompt and answer.
- [x] AC4: The same flow can run in Jira: with `approval.jira: comment` the plan is posted (one comment, updated per version) and each decision and the freeze are comments of their own, so a ticket gets many comments, with the hashes of the plan and of each decision. A comment Jira does not take is reported and journaled and never changes a decision. Transitions are later.
- [x] AC5: Results of a plan without a human approval are marked as such in the matrix, report, junit and Jira comment (which model approved it, when, with the hashes). A flow without a person step is the project's decision to automate: its results stay as code computed them; a project that sets `approval.model_only: review` gets NEEDS_REVIEW for their PASSED results instead.
- [x] AC6: `qj audit verify` checks the approval records against the journal and the approved plan; any mismatch fails the audit and the publish gates.

### REQ-PLAN-11 · Exploration before planning, accepted by a person

- Status: implemented
- Priority: should
- Stage: later
- Related: REQ-EXEC-15, REQ-EXEC-24, REQ-EXEC-25, REQ-PLAN-03, REQ-PLAN-04, REQ-PLAN-05, REQ-PLAN-06, REQ-KNOW-01, INV-3, INV-4
- Note: accepted by the owner on 2026-10-18 and implemented: `qj explore review` (accept, reject, keep), accepted items in the planner's context, `{kind: explore}` sources, and code that turns ungrounded cases and uncovered not-done items into open questions.

Exploratory sessions run before the plan: browser, mobile or command-line, on the ticket's change. A person reviews
what they found and accepts or rejects each observation, finding and not-done checklist item. The planner then sees
only what the person accepted and may propose cases from it, each citing its source; the plan is still reviewed and
approved as usual. Exploration says what is worth testing; it never says what the right result is.

**Acceptance criteria**

- [x] AC1: `qj explore review <TICKET> [--session S01]` lists every observation (`O1`), finding (`F1`) and not-done checklist item (`C3`) of the run's sessions with their actions and evidence, and records for each one accepted or rejected, by whom, when and an optional note; `--accept O1,F2` and `--reject O3` do the same without prompts (CI, scripts). Nothing is accepted by default and an agent cannot accept.
- [x] AC2: Every decision is journaled with the person and the SHA-256 of the session's `session.json`; if the session file changes after a decision, the decision no longer counts and the item must be reviewed again.
- [x] AC3: `qj plan` gives the planner the accepted items of the run's sessions (title, kind, what was seen, the steps as recorded actions) as untrusted data; rejected and unreviewed items never reach it, and the plan review says how many accepted items were offered.
- [x] AC4: A case proposed from exploration cites its source (`explore:S01/O2`); code rejects a citation of an item that does not exist, is not accepted, or belongs to another run.
- [x] AC5: Expected values of such a case come from the ticket, the documentation, an imported case or the person, cited as usual (REQ-PLAN-03, REQ-PLAN-09); what the application did during exploration is never an expected value. A case without such a source becomes an open question (REQ-PLAN-05), never an expectation copied from the observation.
- [x] AC6: An accepted not-done checklist item becomes a proposed case or an open question; the plan review lists those it covers and those it does not, so a gap left by exploration stays visible.
- [x] AC7: The plan review marks cases from exploration with their source and links to the session report; the plan is approved and frozen as any other (REQ-PLAN-04, REQ-PLAN-06); nothing from exploration runs before that.
- [x] AC8: An accepted observation can be kept in the project's knowledge base as known behaviour of the area it concerns (`qj explore review --keep O1`), so planners of later tickets touching that area see it, cited and checked like any other document.

### REQ-PLAN-12 · Numbers written as text in expectations, converted by code

- Status: implemented
- Priority: should
- Stage: later
- Related: REQ-PLAN-09, REQ-PLAN-04, INV-4
- Note: accepted by the owner on 2026-10-21 and implemented.

Local and cloud planners alike write numeric expectations as text (`total: "1.01"` where the API returns the number
`1.01`). Code flags them (REQ-PLAN-09/AC2), the planner often keeps them after its one automatic revision, and the
person has to ask for a revision by hand. When the API description leaves no doubt, code can fix the type itself.

**Acceptance criteria**

- [x] AC1: When the OpenAPI response schema says a field is `number` or `integer` and a plan expects a string that is exactly a decimal number (`"1.01"`, `"80"`, `"-3"`), code converts it to that number before the plan version is shown, and lists every conversion (case, step, field, from, to) next to the plan.
- [x] AC2: Anything else stays as written and is flagged as today: other number formats (`"1,01"`, `"$1.01"`, `"1.01 PLN"`, `" 1.01"`, `"1e3"`), a fraction for an `integer` field, a string field, a field the schema does not describe, or a project without an OpenAPI document.
- [x] AC3: Only the type changes, never the value; the converted value is what the person approves and what the approved plan's SHA-256 covers.
- [x] AC4: The conversion is deterministic code with fixture tests, including values that must not be converted.

### REQ-PLAN-13 · Ticket readiness gate

- Status: in-progress
- Priority: should
- Stage: 2
- Related: REQ-PLAN-05, REQ-CTX-01, REQ-FLOW-02

- Note: TO BE REVIEWED (2026-10-22): an unknown environment is reported as a gap but does not stop planning: the plan does not need it and `qj run --env` names it later; asking the ticket's author would be the wrong person. AC2's move to "needs info" works with a `workflow` mapping (REQ-FLOW-02); AC6's automatic re-check comes with REQ-FLOW-01.

Before planning, code and the planner check that the ticket can be tested at all.

**Acceptance criteria**

- [x] AC1: Checks: acceptance criteria present, scope understandable, linked change found (when code access is not `none`), target environment known.
- [x] AC2: A ticket that fails the gate gets a list of concrete questions instead of a plan; in the Jira workflow it moves to the configured "needs info" status (REQ-FLOW-02).
- [x] AC3: The person can override the gate explicitly; the override is recorded in `run.json`.
- [x] AC4: The result is READY, NEEDS_CLARIFICATION or NOT_TESTABLE, with a risk level (low, medium, high) and a list of requirement gaps, posted to the ticket as a structured comment.
- [x] AC5: The risk level is computed by rules from the change (paths, components, migrations, security-relevant areas) where code access allows; the agent may add reasons but cannot lower a computed level.
- [ ] AC6: A ticket answered after NEEDS_CLARIFICATION is checked again automatically when it returns to the start status.

### REQ-PLAN-14 · Coverage matrix computed by code

- Status: implemented
- Priority: must
- Stage: 2
- Related: REQ-PLAN-02, REQ-PLAN-03, REQ-CTX-05, REQ-PLAN-10, INV-6
- Note: accepted by the owner on 2026-10-21 and implemented. Endpoints come from the analysis (method and path); screens and components are left to a later change.

Whether the plan covers the ticket and the change is computed, not claimed by the agent.

**Acceptance criteria**

- [x] AC1: Every acceptance criterion of the ticket maps to at least one test case or to an explicit exclusion with a reason.
- [x] AC2: With code access `full`, every changed endpoint, screen or component found in the diff maps to a test case or an explicit exclusion.
- [x] AC3: Uncovered items are shown to the reviewer as a risk list next to the plan ("changed but not tested").
- [x] AC4: A plan with uncovered items cannot be approved without an explicit confirmation, recorded in `run.json`.

### REQ-PLAN-15 · Project lessons from revisions

- Status: proposed
- Priority: should
- Stage: 7
- Related: REQ-PLAN-04, REQ-CTX-07, REQ-KNOW-01, REQ-PRJ-04

Each human correction makes the next plan better.

**Acceptance criteria**

- [ ] AC1: After approval, the differences between the first and the approved plan version are summarised as lessons (for example "always test both admin and user roles").
- [ ] AC2: Lessons are stored in the project home and can be listed and removed (`qj lessons list|remove`).
- [ ] AC3: The planner gets the relevant lessons and previously approved plans of similar tickets as examples.
- [ ] AC4: Lessons never leave the project (REQ-PRJ-04).

### REQ-PLAN-16 · Plan quality metrics

- Status: implemented
- Priority: should
- Stage: 7
- Related: REQ-PLAN-04, REQ-LLM-07, REQ-OBS-04, INV-6

**Acceptance criteria**

- [x] AC1: Per project: share of plans approved without changes, average number of revision rounds, share of tickets stopped by the readiness gate (REQ-PLAN-13).
- [x] AC2: Defects reported later on a ticket marked as passed can be linked to the run (escaped defects).
- [x] AC3: The metrics are shown in `qj status` and `qj metrics` (in the web console with REQ-WEB-01); numbers are computed from run records.
- [x] AC4: Per project also: false FAILED (FAILED cases later triaged as a test or environment problem), auditor downgrades of PASSED, and escaped defects (AC2), so a team sees whether tests check enough.

### REQ-PLAN-17 · Test cases from recorded steps

- Status: accepted
- Priority: should
- Stage: later
- Related: REQ-PLAN-03, REQ-PLAN-11, REQ-CTX-08, REQ-EXEC-21, REQ-PUB-08, INV-3, INV-4, INV-8

A tester clicks through a scenario once in a browser or on a device; QAJitsu turns the recording into a plan case and an
automated test, so known flows need no writing from scratch.

**Acceptance criteria**

- [ ] AC1: `qj record <TICKET> [--env <profile>] [--web | --android | --ios]` opens a browser or the device with the environment and records every action (navigation, clicks, typing, selections, gestures, uploads) with a screenshot, the element's stable selectors (REQ-EXEC-21) and the network calls it caused.
- [ ] AC2: The person marks checks while recording ("this text must be visible", "this field equals", "this request returns 201"); expectations come only from these marks or from values the person confirms afterwards, never invented by an agent.
- [ ] AC3: Typed values are masked as they are recorded: a field of type password, a value equal to a known secret, or one the person marks as secret becomes a `secret://` reference or a test account alias; nothing unmasked is stored.
- [ ] AC4: Code turns the recording into a plan case (steps, expectations, data, source `recording:<id>`); an agent may only name and group the steps and propose missing checks, each shown as a proposal for the person to accept.
- [ ] AC5: The recorded case goes through the normal review and approval of a plan version (frozen with its hash); a recording never runs as an approved case by itself.
- [ ] AC6: From the approved case the author writes the spec with the recorded selectors; the recording, screenshots and network calls are kept as evidence of how the case was made.
- [ ] AC7: A recording made against hosts outside the environment allowlist, or with an action QAJitsu cannot replay, is refused or marked with the step it cannot replay.
- [ ] AC8: An approved recorded case can become an automated test in the team's tests repository (Playwright, Appium or Maestro, REQ-EXEC-52) through `qj promote` (REQ-PUB-08), after it passed a run; it then runs in `qj regression` without models.
- [ ] AC9: Besides `qj record`, recordings can be imported: Playwright codegen scripts, Chrome DevTools Recorder exports and HAR files of API calls, treated as untrusted input and converted by code the same way.
- [ ] AC10: Recording works for web, Android and iOS (taps, typing, gestures from the device), with the same masking and review.

### REQ-PLAN-18 · Mapping existing automated tests to cases and requirements

- Status: accepted
- Priority: should
- Stage: later
- Related: REQ-PLAN-14, REQ-PLAN-17, REQ-CTX-08, REQ-PUB-08, REQ-EXEC-52

Teams that already have automated tests (Playwright, Cypress, Selenium, Appium, Maestro, REST Assured, Postman) want them
linked to tickets and acceptance criteria instead of written again.

**Acceptance criteria**

- [ ] AC1: QAJitsu reads the tests of the tests repository and builds a map: test file and title, the steps and assertions found by code, the pages, screens or endpoints they touch.
- [ ] AC2: The planner proposes for each acceptance criterion of a ticket the existing tests that cover it, each link citing the test file and the assertion; links are checked by code against the real files and titles, and a person accepts them.
- [ ] AC3: Accepted links appear in the coverage matrix (REQ-PLAN-14) as "covered by an existing test", with the test's last known result; a criterion covered only by a test that is not run in this run stays an open gap.
- [ ] AC4: An existing test can be added to a run as a regression case, executed by its own runner with its own verdict; QAJitsu never rewrites its assertions.
- [ ] AC5: A recording (REQ-PLAN-17) can be compared with existing tests: when one already covers the same flow, QAJitsu says so before a new case is created.
