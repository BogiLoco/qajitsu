# Jira workflow (FLOW)

QAJitsu works inside the team's Jira workflow like a human tester: a status change starts it, the plan is approved in the ticket, results come back as a comment and the ticket moves according to the verdict computed by code.

### REQ-FLOW-01 · Start from a Jira status

- Status: proposed
- Priority: should
- Stage: 10
- Related: REQ-CI-02

Extends REQ-CI-02 (a Jira automation that dispatches a pipeline) with QAJitsu picking tickets up itself.

**Acceptance criteria**

- [ ] AC1: Push mode: a Jira Automation rule or webhook calls QAJitsu when a ticket enters the configured start status (default "Ready for QA").
- [ ] AC2: Pull mode for workers behind a firewall: a configurable JQL query is polled at a configurable interval.
- [ ] AC3: Webhook requests are authenticated with a shared secret or a signature; unauthenticated requests are rejected and logged.
- [ ] AC4: The ticket is picked up and moved to the "in testing" status with a comment saying a run started.

### REQ-FLOW-02 · Status mapping per project

- Status: proposed
- Priority: must
- Stage: 10
- Related: REQ-FLOW-01, REQ-CFG-01

**Acceptance criteria**

- [ ] AC1: The project config maps roles to the team's own status names: start, in testing, waiting for plan approval, needs info, passed, failed, needs human review.
- [ ] AC2: `qj doctor` checks that the mapped statuses and transitions exist in the Jira project and that the service account may perform them.
- [ ] AC3: A missing transition at run time leaves the ticket where it is and adds a comment; the run result is not lost.

### REQ-FLOW-03 · Plan approval in the ticket

- Status: proposed
- Priority: must
- Stage: 10
- Related: REQ-PLAN-04, REQ-PLAN-06, REQ-PLAN-07, REQ-PLAN-10, ADR-0010

Implements REQ-PLAN-07/AC3 (approval in Jira by comment) inside the approval flow of REQ-PLAN-10.

**Acceptance criteria**

- [ ] AC1: The plan is posted as a ticket comment with version number, cases, exclusions and the coverage risk list (REQ-PLAN-14).
- [ ] AC2: Commands in comments: `/qj approve`, `/qj revise <text>` (the planner posts the next version with a change list), `/qj reject <reason>` (no testing; the ticket goes to "needs info").
- [ ] AC3: Only members of a configured Jira group may approve, revise or reject; commands from others are ignored with a reply.
- [ ] AC4: An approval freezes exactly the version it answers; a command for an older version is rejected.
- [ ] AC5: Silence is never approval: reminders after a configurable time; a plan is approved without a person only by the model steps the project configured (REQ-PLAN-10).
- [ ] AC6: After a configurable number of revision rounds the planner stops and asks a person to edit the plan directly.
- [ ] AC7: Every version, command, author and time stays in the ticket and in `run.json`.

### REQ-FLOW-04 · Transition policy from the verdict

- Status: proposed
- Priority: must
- Stage: 10
- Related: REQ-VER-01, REQ-VER-07, REQ-PUB-01, REQ-PUB-05, INV-1

Implements REQ-PUB-05/AC3 (transition the ticket after a run).

**Acceptance criteria**

- [ ] AC1: All cases PASSED: the ticket moves to the "passed" status; moving it to Done is allowed only when the project enables it explicitly.
- [ ] AC2: Confirmed FAILED (after retries, REQ-EXEC-08): the ticket moves back to development, assigned to the change's author, with reproduction steps and evidence links.
- [ ] AC3: BLOCKED, NEEDS_REVIEW, FLAKY or NOT_RUN: the ticket stays in testing, gets a label and is assigned to the configured QA person; it never goes to Done or back to development.
- [ ] AC4: The transition is decided by code from the computed matrix only; agents cannot trigger transitions.
- [ ] AC5: The results comment is published before the transition (REQ-PUB-01).

### REQ-FLOW-05 · One run per ticket and loop limits

- Status: proposed
- Priority: must
- Stage: 10
- Related: REQ-FLOW-01, REQ-PUB-04

**Acceptance criteria**

- [ ] AC1: At most one active run per ticket; duplicate events are ignored and logged.
- [ ] AC2: A configurable maximum number of runs per ticket per day; after it the ticket goes to human review.
- [ ] AC3: A new run after a fix reuses the approved plan when the ticket did not change; a changed ticket needs a new approval.

### REQ-FLOW-06 · Cost budget per ticket and per month

- Status: proposed
- Priority: should
- Stage: 10
- Related: REQ-LLM-07, REQ-LLM-09, REQ-CI-05

The run budget (`budget.max_cost_usd`) limits one run; this limits a ticket and a project over time.

**Acceptance criteria**

- [ ] AC1: Token, cost and runtime budgets per ticket and per project per month.
- [ ] AC2: Reaching a budget stops new work for the ticket with a comment; finished results are still published.

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
