# Publishing results (PUB)

How results and evidence reach Jira and the people who need them.

### REQ-PUB-01 · Jira comment

- Status: implemented
- Priority: must
- Stage: 4
- Related: REQ-EVD-04, REQ-VER-07, REQ-VER-10

**Acceptance criteria**

- [x] AC1: Header: run id, date, environment, tested SHAs and build, executor, plan version.
- [x] AC2: Summary counts and the matrix.
- [x] AC3: Per failure: step, expected vs actual, names of the screenshot and video attachments.
- [x] AC4: A local reproduction command, e.g. `qajitsu evidence SHOP-482 --run <id> --failed`.

### REQ-PUB-02 · Attachments

- Status: deferred
- Priority: must
- Stage: 4
- Related: REQ-EVD-06

Deferred: AC3 (object storage for oversized attachments) is parked; oversized files are skipped and reported.

**Acceptance criteria**

- [x] AC1: `<TICKET>_<RUN-ID>_evidence.zip` with the evidence folder, `report.html` and manifest.
- [x] AC2: Failure screenshots and videos attached individually so they are visible without unzipping.
- [ ] AC3: Sizes checked against the instance limit; oversized files go to object storage (S3, MinIO, Azure Blob) with a time-limited link.

### REQ-PUB-03 · Jira Cloud and Data Center

- Status: implemented
- Priority: should
- Stage: 4
- Related: REQ-CTX-01

**Acceptance criteria**

- [x] AC1: Cloud: REST API v3, comments in Atlassian Document Format, attachments with `X-Atlassian-Token: no-check`.
- [x] AC2: Data Center: REST API v2 with wiki markup (later stage).

### REQ-PUB-04 · Idempotent publishing

- Status: implemented
- Priority: must
- Stage: 4
- Related: REQ-WS-01

**Acceptance criteria**

- [x] AC1: The comment id is stored in `run.json`; publishing the same run again updates the comment.
- [x] AC2: A new run adds a new comment; earlier comments stay as history.

### REQ-PUB-05 · Optional integrations

- Status: deferred
- Priority: could
- Stage: later
- Related: REQ-CI-04

Deferred: AC1-AC3 (Xray/Zephyr import, draft bug tickets, ticket transitions) are parked; AC4 is done. Bug drafts continue in REQ-PUB-07.

**Acceptance criteria**

- [ ] AC1: Import results into Xray or Zephyr Scale.
- [ ] AC2: Draft bug tickets for FAILED cases, created only after user confirmation.
- [ ] AC3: Transition the ticket status after a run (configurable).
- [x] AC4: Short result comment on the PR/MR.

### REQ-PUB-06 · Failure videos and evidence for the user

- Status: implemented
- Priority: must
- Stage: 5
- Related: REQ-EVD-02, REQ-OBS-02

**Acceptance criteria**

- [x] AC1: `qajitsu evidence <TICKET>` opens `report.html` of the latest run.
- [x] AC2: `--failed` opens failure videos in the system player; `--trace <case>` opens Playwright Trace Viewer.
- [x] AC3: `qajitsu pull <TICKET> --run <id>` downloads evidence of a CI run from Jira or object storage.

### REQ-PUB-07 · Bug reports from failed cases

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-PUB-05, REQ-PUB-03, INV-6, INV-8

Extends REQ-PUB-05/AC2 (draft bug tickets).

**Acceptance criteria**

- [ ] AC1: Before drafting, QAJitsu searches Jira for similar open bugs (project, component, key words from the failure) and shows matches; the user can link to an existing bug instead.
- [ ] AC2: Steps to reproduce come from the run's journal and results, not from agent text; expected values come from the plan.
- [ ] AC3: The draft includes the tested version (commit, build), environment, browser or device, and evidence references by hash.
- [ ] AC4: The bug is created only after user confirmation and linked to the tested ticket; nothing is created in CI without an explicit setting.
- [ ] AC5: Everything goes through masking before it reaches Jira.

### REQ-PUB-08 · Promote ticket cases to the regression suite

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-CTX-06, REQ-EXEC-01, INV-4

Work spent on one ticket builds the regression suite instead of being lost.

**Acceptance criteria**

- [ ] AC1: `qj promote <TICKET> [--cases TC-01,TC-03]` opens a PR/MR in the tests repository with the selected specs.
- [ ] AC2: Only cases that were PASSED in a run of the approved plan can be promoted; others are refused with the reason.
- [ ] AC3: Promoted specs keep their expectations from the plan and follow the tests repository's conventions; the PR/MR links the ticket and the run.
- [ ] AC4: Nothing is pushed without user confirmation.

### REQ-PUB-09 · Release readiness report

- Status: proposed
- Priority: could
- Stage: later
- Related: INV-6, REQ-VER-08, REQ-PUB-01

**Acceptance criteria**

- [ ] AC1: `qj release <fixVersion | sprint>` collects the tickets and their latest runs into one report.
- [ ] AC2: The report shows per ticket the status counts, open FAILED and NEEDS_REVIEW cases, and tickets with no run.
- [ ] AC3: All numbers are computed from structured results; a ticket without results is never counted as passed.
- [ ] AC4: The report can be published to Jira (a version page or comment) after preview.
