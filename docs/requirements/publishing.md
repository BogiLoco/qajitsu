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

- Status: in-progress
- Priority: must
- Stage: 4
- Related: REQ-EVD-06

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

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-CI-04

**Acceptance criteria**

- [ ] AC1: Import results into Xray or Zephyr Scale.
- [ ] AC2: Draft bug tickets for FAILED cases, created only after user confirmation.
- [ ] AC3: Transition the ticket status after a run (configurable).
- [ ] AC4: Short result comment on the PR/MR.

### REQ-PUB-06 · Failure videos and evidence for the user

- Status: implemented
- Priority: must
- Stage: 5
- Related: REQ-EVD-02, REQ-OBS-02

**Acceptance criteria**

- [x] AC1: `qajitsu evidence <TICKET>` opens `report.html` of the latest run.
- [x] AC2: `--failed` opens failure videos in the system player; `--trace <case>` opens Playwright Trace Viewer.
- [x] AC3: `qajitsu pull <TICKET> --run <id>` downloads evidence of a CI run from Jira or object storage.
