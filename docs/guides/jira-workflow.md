# The Jira workflow

QAJitsu can work inside your team's Jira workflow: post the plan to the ticket and take its approval from a comment,
move the ticket after a run by the computed result, and keep one run per ticket at a time. All of it is optional and
off until the project maps its statuses. Code decides every move; no agent can trigger one.

Requirements: REQ-FLOW-02 (status mapping), REQ-FLOW-03 (approval in the ticket), REQ-FLOW-04 (transition policy),
REQ-FLOW-05 (one run per ticket, loop limits), REQ-PLAN-13/AC2 (readiness → "needs info").

## Map your statuses

Your workflow has its own status names. Tell QAJitsu which status plays which role:

```yaml
# .qa/qa.project.yaml
workflow:
  statuses:
    start: "Ready for QA"
    in_testing: "In QA"
    waiting_for_approval: "Plan review" # optional
    needs_info: "Needs info"
    passed: "QA passed"
    failed: "In development"
    needs_review: "QA review"
    done: "Done" # used only with passed_to_done
  passed_to_done: false # all PASSED stops at "passed" unless you enable this
  qa_assignee: <jira-account-id> # who gets tickets that need a person
  authors: { octocat: <jira-account-id> } # code host login → Jira account, for FAILED tickets
  attention_label: qa-needs-attention
  max_runs_per_day: 5
  approvers_group: qa-leads # who may answer plans in the ticket
  remind_after_h: 24
  max_revisions: 3
  pickup:
    jql: 'project = SHOP AND status = "Ready for QA" AND labels = qa-agent' # optional
    interval_s: 300
    batch: 5
    secret: secret://env/QJ_WEBHOOK_SECRET # push mode
    host: 127.0.0.1
    port: 8787
```

On Jira Cloud the accounts are account ids; on Data Center user names.

`qj doctor --online` checks that every mapped status exists in the project's workflows and that the service account
has the `TRANSITION_ISSUES` permission. With ticket files (`jira.type: file`, the demo) the check runs offline;
`tickets/workflow.json` can list the allowed transitions (`{ "transitions": { "Ready for QA": ["In QA"] } }`) and
groups (`{ "groups": { "qa-leads": ["acc-anna"] } }`).

## What moves the ticket

| When                                                   | The ticket goes to                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `qj plan` stops at the readiness gate                  | `needs_info` (unless `--override-readiness`)                             |
| `qj workflow sync` posts a plan                        | `waiting_for_approval`, when mapped                                      |
| `/qj approve v<N>` accepted                            | `in_testing`                                                             |
| `/qj reject <reason>`                                  | `needs_info`                                                             |
| `qj publish`: every case PASSED                        | `passed` (`done` only with `passed_to_done`)                             |
| `qj publish`: a case FAILED                            | `failed`, assigned to the change's author when `authors` maps them       |
| `qj publish`: BLOCKED, NEEDS_REVIEW, FLAKY, NOT_RUN    | stays in `in_testing`, gets `attention_label`, assigned to `qa_assignee` |
| `qj fetch` after `max_runs_per_day` runs of the ticket | `needs_review`, no new run                                               |

The results comment is always published first. When the workflow offers no transition to the target status, or Jira
fails, the ticket stays where it is, a comment says why, and the journal records `ticket.transition` with
`moved: false`; the run's result is never lost over a status.

## Picking tickets up

QAJitsu can start by itself when a ticket enters the start status:

- **Pull** (`qj workflow poll`, or `--once` from cron): finds the tickets in `statuses.start` (or your
  `pickup.jql`) every `pickup.interval_s` seconds, at most `pickup.batch` at a time.
- **Push** (`qj workflow serve`): a Jira Automation rule sends `{"ticket": "{{issue.key}}"}` to `POST /jira` with the
  header `X-QAJitsu-Token: <secret>`, or a Jira webhook signs its body (`X-Hub-Signature`). The secret comes from
  `pickup.secret` (`secret://...`); without it the server refuses to start. Refused requests are logged in
  `<runs>/pickup.jsonl` without their body.

Picking up means: a new run (with the one-active-run and daily limits below), the ticket moves to `in_testing` with a
comment that the run started, the plan is written after the readiness gate, and posted for approval. A ticket that
went to `needs_info` and comes back to the start status is checked again from scratch. Only the tracker's status
counts (a webhook body is never trusted for it), and a ticket whose last run is still open is not picked up again;
`qj work reset <TICKET>` closes that run.

## Approving the plan in the ticket

`qj workflow sync <TICKET>` runs the approval loop. Call it from a scheduler or a Jira automation; each call does what
is due:

1. Posts the plan version waiting for approval: cases with type and priority, what is not tested, what no case covers,
   expectations code cannot check as written, and for a revision the change list against the version before.
2. Reads new comments and acts on commands at the start of a line:
   - `/qj approve v2` freezes exactly v2 (SHA-256, as `qj approve`). Approving confirms the coverage and check lists
     posted with that version. Another version, or a comment written before v2 was posted, is refused.
   - `/qj revise <what to change>` has the planner write the next version, which is posted with its change list.
     After `max_revisions` rounds QAJitsu asks a person to edit the plan directly.
   - `/qj reject <reason>` ends planning for the run; the ticket moves to `needs_info`.
3. Reminds after `remind_after_h` hours without an answer. Silence never approves; only model steps you configured in
   the approval flow (`approval.flow`) approve without a person.

Only members of `approvers_group` decide. Anybody else gets a reply and the command is ignored. Once a plan is
approved or rejected, later commands are ignored. Every version, command, author and time is in the ticket, in
`run.json` (`ticketFlow`) and in the journal (`plan.posted_to_ticket`, `ticket.command`, `plan.reminder`).

Comment text is untrusted data. Only an approver's revise instruction reaches the planner, the same way
`qj plan --revise` does. Reasons are masked before they are stored. QAJitsu's own comments start with "QAJitsu" and
are never read as commands, so a plan that quotes `/qj approve` approves nothing.

## One run per ticket

With a `workflow` section, `qj fetch` starts no run while another run of the ticket is active (a live process holds its
lock). The duplicate event is ignored, exit code `0`, and logged in `<runs>/<TICKET>/flow.jsonl`. A crashed run whose
process is gone does not block. After `max_runs_per_day` runs of a ticket in a day (UTC) the next one is refused (exit
code `2`) and the ticket goes to `needs_review`.

A new run after a fix reuses the approved plan when the ticket did not change:
`qj approve <TICKET> --reuse-from latest`. A changed ticket needs a new approval.

Without a `workflow` section none of this applies: parallel runs of a ticket stay allowed and QAJitsu moves nothing.
