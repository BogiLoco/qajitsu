# Jira workflow (FLOW)

QAJitsu works inside the team's Jira workflow like a human tester: a status change starts it, the plan is approved in the ticket, results come back as a comment and the ticket moves according to the verdict computed by code.

### REQ-FLOW-01 · Start from a Jira status

- Status: implemented
- Priority: should
- Stage: 10
- Related: REQ-CI-02

Extends REQ-CI-02 (a Jira automation that dispatches a pipeline) with QAJitsu picking tickets up itself.

**Acceptance criteria**

- [x] AC1: Push mode: a Jira Automation rule or webhook calls QAJitsu when a ticket enters the configured start status (default "Ready for QA").
- [x] AC2: Pull mode for workers behind a firewall: a configurable JQL query is polled at a configurable interval.
- [x] AC3: Webhook requests are authenticated with a shared secret or a signature; unauthenticated requests are rejected and logged.
- [x] AC4: The ticket is picked up and moved to the "in testing" status with a comment saying a run started.

### REQ-FLOW-02 · Status mapping per project

- Status: implemented
- Priority: must
- Stage: 10
- Related: REQ-FLOW-01, REQ-CFG-01

**Acceptance criteria**

- [x] AC1: The project config maps roles to the team's own status names: start, in testing, waiting for plan approval, needs info, passed, failed, needs human review.
- [x] AC2: `qj doctor` checks that the mapped statuses and transitions exist in the Jira project and that the service account may perform them.
- [x] AC3: A missing transition at run time leaves the ticket where it is and adds a comment; the run result is not lost.

### REQ-FLOW-03 · Plan approval in the ticket

- Status: implemented
- Priority: must
- Stage: 10
- Related: REQ-PLAN-04, REQ-PLAN-06, REQ-PLAN-07, REQ-PLAN-10, ADR-0010
- Note: `qj workflow sync <TICKET>` runs the loop (from a scheduler or a Jira automation); approving with `/qj approve v<N>` confirms the coverage and check lists posted with that version. QAJitsu's own comments start with "QAJitsu" and are never commands.

Implements REQ-PLAN-07/AC3 (approval in Jira by comment) inside the approval flow of REQ-PLAN-10.

**Acceptance criteria**

- [x] AC1: The plan is posted as a ticket comment with version number, cases, exclusions and the coverage risk list (REQ-PLAN-14).
- [x] AC2: Commands in comments: `/qj approve`, `/qj revise <text>` (the planner posts the next version with a change list), `/qj reject <reason>` (no testing; the ticket goes to "needs info").
- [x] AC3: Only members of a configured Jira group may approve, revise or reject; commands from others are ignored with a reply.
- [x] AC4: An approval freezes exactly the version it answers; a command for an older version is rejected.
- [x] AC5: Silence is never approval: reminders after a configurable time; a plan is approved without a person only by the model steps the project configured (REQ-PLAN-10).
- [x] AC6: After a configurable number of revision rounds the planner stops and asks a person to edit the plan directly.
- [x] AC7: Every version, command, author and time stays in the ticket and in `run.json`.

### REQ-FLOW-04 · Transition policy from the verdict

- Status: implemented
- Priority: must
- Stage: 10
- Related: REQ-VER-01, REQ-VER-07, REQ-PUB-01, REQ-PUB-05, INV-1

Implements REQ-PUB-05/AC3 (transition the ticket after a run).

**Acceptance criteria**

- [x] AC1: All cases PASSED: the ticket moves to the "passed" status; moving it to Done is allowed only when the project enables it explicitly.
- [x] AC2: Confirmed FAILED (after retries, REQ-EXEC-08): the ticket moves back to development, assigned to the change's author, with reproduction steps and evidence links.
- [x] AC3: BLOCKED, NEEDS_REVIEW, FLAKY or NOT_RUN: the ticket stays in testing, gets a label and is assigned to the configured QA person; it never goes to Done or back to development.
- [x] AC4: The transition is decided by code from the computed matrix only; agents cannot trigger transitions.
- [x] AC5: The results comment is published before the transition (REQ-PUB-01).

### REQ-FLOW-05 · One run per ticket and loop limits

- Status: implemented
- Priority: must
- Stage: 10
- Related: REQ-FLOW-01, REQ-PUB-04, REQ-WS-04
- Note: applies to projects with a `workflow` section (the Jira flow); without it parallel runs of a ticket stay allowed (REQ-WS-04/AC2). A run is active while a live process holds its lock; AC3 is `qj approve --reuse-from latest` (REQ-CI-03/AC4).

**Acceptance criteria**

- [x] AC1: At most one active run per ticket; duplicate events are ignored and logged.
- [x] AC2: A configurable maximum number of runs per ticket per day; after it the ticket goes to human review.
- [x] AC3: A new run after a fix reuses the approved plan when the ticket did not change; a changed ticket needs a new approval.

### REQ-FLOW-06 · Cost budget per ticket and per month

- Status: implemented
- Priority: should
- Stage: 10
- Related: REQ-LLM-07, REQ-LLM-09, REQ-LLM-10, REQ-LLM-11, REQ-CI-05, REQ-FLOW-05, REQ-WEB-11, REQ-SCALE-06, INV-1, INV-6
- Note: pulled into the MVP list by the owner on 2026-11-17. Owner decisions: runtime is active time
  (REQ-NFR-11/AC2); a ticket's budget is per version of its content (summary, description and acceptance criteria),
  so a ticket whose requirements changed starts a new window; a local model (Ollama, or a loopback address) costs
  nothing, a paid model without a price is refused under a cost limit; the auditor's cost is shared equally between
  the cases it reviewed and marked as apportioned. The data is the one the later cost view (REQ-WEB-11) needs.
  REQ-SCALE-06 is the later per-tenant counterpart.

The run budget (`budget.max_cost_usd`) limits one run; this limits a ticket and a project over time.

**Acceptance criteria**

- [x] AC1: `budget` keeps the run limits and adds `budget.ticket` and `budget.month`, each with optional `max_cost_usd`, `max_tokens` and `max_minutes` (active minutes, REQ-NFR-11/AC2), and `budget.time_zone` (IANA, default `UTC`) for the calendar month; invalid values are rejected when the config loads.
- [x] AC2: Every model call and every finished command adds an entry to the project's spend ledger (`<project runs>/budget/spend.jsonl`, under a lock, written by code only): time, project, ticket, ticket version, run, stage, role, model, case ids, input, cached and output tokens, cost (`null` for a paid model without a price) and active time. The run journals are the authority: `qj budget --rebuild` regenerates the ledger with the same totals, and a ledger that does not parse or does not match the journals refuses new work until it is rebuilt.
- [x] AC3: Costs are attributed by code: the author's and the healer's calls to their case, the auditor's call equally to the cases it reviewed (marked apportioned), analysis, plan and approval to the ticket as shared work; they are summed per case, per ticket version, per ticket, per project and per calendar month in `budget.time_zone`, by role, model and stage. A call belongs to the month of its own time.
- [x] AC4: A ticket's version is the hash of its summary, description and acceptance criteria; the ticket budget counts the spend since that version first appeared, so changed requirements start a new window, while a new status, comment or label does not. Earlier versions' spend stays in the ledger and the reports.
- [x] AC5: Budgets are checked before a new run starts (`qj fetch`, workflow sync, `qj ci`: a scope at its limit starts nothing, exit 2 with the reason), before every model call (a scope at its limit sends nothing), after every model call (the limit reached stops the stage, naming the scope) and before each case for the minutes; parallel runs share the ledger, so a limit is exceeded by at most the calls already in flight.
- [x] AC6: When a ticket or month budget stops work, stopped model stages are BLOCKED and cases without a spec NOT_RUN, each with the scope, spent amount, limit and period; written specs still run, failing cases are not healed and stay FAILED, and a stopped audit counts as failed (REQ-VER-06). A budget never sets or raises a status, and never removes results, evidence or report entries; finished results are reported and published.
- [x] AC7: A local model (provider type `ollama`, or a loopback address that is not a `gateway`) costs nothing. A paid model with no known price (config, built-in or gateway, REQ-LLM-09/AC2, REQ-LLM-10) is refused under a ticket or month cost limit before the call is sent (the run limit keeps REQ-LLM-09/AC3: its cost shows as unknown), with how to declare its price; a cost total is never shown as $0 or within budget because a price was missing.
- [x] AC8: When a budget stopped work in a run, the ticket comment has one budget section (scope, period, spent, limit, cases NOT_RUN or BLOCKED because of it, finished results included), with numbers from the ledger and the results (INV-6); with a `workflow` section the ticket also moves to `needs_review` (REQ-FLOW-05/AC2), unless a case FAILED: then it goes back to development as REQ-FLOW-04 says, with the budget section in the comment.
- [x] AC9: `qj budget [--month YYYY-MM] [--ticket KEY] [--json]` shows spend against every limit (cost, tokens, minutes, percent), the most expensive tickets and cases, and calls without a price; `--ticket` breaks it down per version, case and shared stage, by role, model and stage. `qj status` adds the month's line and the tickets at 80% or more of their budget.

### REQ-FLOW-07 · Run commands in ticket comments

- Status: proposed
- Priority: should
- Stage: 10
- Related: REQ-FLOW-03, REQ-FLOW-05

**Acceptance criteria**

- [ ] AC1: `/qj rerun` starts a new run with the approved plan, within the limits of REQ-FLOW-05.
- [ ] AC2: `/qj cancel` stops the active run; finished cases keep their results, unfinished cases become NOT_RUN.
- [ ] AC3: `/qj status` replies with the current stage, case counts and a link to the run in the web console.
- [ ] AC4: Commands follow the same permission check as plan approval (REQ-FLOW-03/AC3); every command and its effect is logged in the ticket and `run.json`.

### REQ-FLOW-08 · QA result field and labels in Jira

- Status: proposed
- Priority: should
- Stage: 10
- Related: REQ-FLOW-04, REQ-VER-08

The result can be filtered in Jira itself (JQL, boards, dashboards).

**Acceptance criteria**

- [ ] AC1: A configurable custom field or label set holds the last result: overall status, case counts, approved plan version and run id.
- [ ] AC2: The values are written by code from the computed matrix (REQ-VER-08); agents cannot write them.
- [ ] AC3: A missing field or permission is reported by `qj doctor` and does not block publishing the comment.

### REQ-FLOW-09 · Ticket actions from the web console

- Status: proposed
- Priority: should
- Stage: 10
- Related: REQ-FLOW-03, REQ-FLOW-07, REQ-WEB-01

**Acceptance criteria**

- [ ] AC1: Approve, revise, reject, rerun and cancel are buttons in the web console for a ticket in the Jira workflow.
- [ ] AC2: Each action is mirrored to the ticket as a comment with the same content and author a comment command would produce.
- [ ] AC3: Console and comment commands share one state: an action already taken in one channel is shown as done in the other and cannot be repeated.

### REQ-FLOW-10 · Human QA partners on demand

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-FLOW-03, REQ-PRJ-04, REQ-CFG-06, REQ-PUB-10

A team can route a ticket to a human tester from a partner (software house or QA company) for exploratory testing or the final release sign-off, inside the same workflow.

**Acceptance criteria**

- [ ] AC1: The project lists approved partners and the tasks they may take: plan review, exploratory session, release sign-off.
- [ ] AC2: A task is sent to a partner by command, button or policy (for example every high-risk ticket); the partner works in the web console with access limited to that ticket, its evidence and the test environment.
- [ ] AC3: Partner findings are recorded as manual results, signed with the partner's identity and time, and shown separately from automated results.
- [ ] AC4: A manual finding can add a FAILED case or block GO (REQ-PUB-10); it never changes the status of an automated case.
- [ ] AC5: A sign-off is recorded in the ticket and the report.
- [ ] AC6: Partner access is time-limited and revoked when the task ends; secrets are never shown (REQ-CFG-06).
- [ ] AC7: Partner work is metered per task for billing and revenue sharing.
