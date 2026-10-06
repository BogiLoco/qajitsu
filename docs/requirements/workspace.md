# Run workspace and cleanup (WS)

Every run lives in its own folder under the ticket, identified by a unique run id.

### REQ-WS-01 · Folder per ticket and run id

- Status: in-progress
- Priority: must
- Stage: 1
- Related: REQ-VER-04, REQ-VER-05, REQ-PRJ-01

**Acceptance criteria**

- [x] AC1: Layout `<root>/<TICKET>/<RUN-ID>/` with RUN-ID `YYYYMMDD-HHMM-xxxx` (UTC time plus 4 random characters).
- [x] AC2: Subfolders: `ticket/`, `plan/`, `repos/`, `env/`, `logs/`, `specs/`, `results/`, `evidence/`, `journal/`, `report/`, plus `run.json`.
- [x] AC3: `<TICKET>/index.json` lists runs with status and retention; `latest` points to the newest run.
- [ ] AC4: The root is configurable; default is `<project-home>/runs/` of the run's project (REQ-PRJ-01), never the project repository.

### REQ-WS-02 · Labels and names for runtime resources

- Status: implemented
- Priority: must
- Stage: 6
- Related: REQ-ENV-03

**Acceptance criteria**

- [x] AC1: Containers, networks and volumes carry `qajitsu.ticket` and `qajitsu.run` labels.
- [x] AC2: Compose project name `qj-<ticket>-<suffix>`.

### REQ-WS-03 · Cleanup policy and retention

- Status: implemented
- Priority: must
- Stage: 6
- Related: REQ-CFG-05, REQ-OBS-05

**Acceptance criteria**

- [x] AC1: `cleanup.policy`: `on_success`, `always` or `never`; `--keep` overrides for one run.
- [x] AC2: Retention: `keep_last` runs per ticket and `max_age_days`.
- [x] AC3: Cleanup removes containers, volumes, networks, worktrees and `.env` files; `--keep` keeps plan, specs, results, evidence, report and journal.
- [x] AC4: Cleanup never touches resources without QAJitsu labels or paths outside the root.

### REQ-WS-04 · Run management commands

- Status: implemented
- Priority: should
- Stage: 6
- Related: REQ-GEN-05

**Acceptance criteria**

- [x] AC1: `qajitsu runs <TICKET>`, `qajitsu resume <TICKET> [--run]`, `qajitsu clean <TICKET> [--run]`, `qajitsu gc`.
- [x] AC2: A lock file prevents two processes from writing the same run; different runs of one ticket may run in parallel.
- [x] AC3: `resume` continues from the last checkpoint in `run.json`.
