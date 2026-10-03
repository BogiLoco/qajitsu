# Run workspace and cleanup (WS)

Every run lives in its own folder under the ticket, identified by a unique run id.

### REQ-WS-01 · Folder per ticket and run id

- Status: implemented
- Priority: must
- Stage: 1
- Related: REQ-VER-04, REQ-VER-05

**Acceptance criteria**

- [x] AC1: Layout `<root>/<TICKET>/<RUN-ID>/` with RUN-ID `YYYYMMDD-HHMM-xxxx` (UTC time plus 4 random characters).
- [x] AC2: Subfolders: `ticket/`, `plan/`, `repos/`, `env/`, `logs/`, `specs/`, `results/`, `evidence/`, `journal/`, `report/`, plus `run.json`.
- [x] AC3: `<TICKET>/index.json` lists runs with status and retention; `latest` points to the newest run.
- [x] AC4: The root is configurable; default is the user's home directory, not the project repository.

### REQ-WS-02 · Labels and names for runtime resources

- Status: accepted
- Priority: must
- Stage: 6
- Related: REQ-ENV-03

**Acceptance criteria**

- [ ] AC1: Containers, networks and volumes carry `qajitsu.ticket` and `qajitsu.run` labels.
- [ ] AC2: Compose project name `qj-<ticket>-<suffix>`.

### REQ-WS-03 · Cleanup policy and retention

- Status: accepted
- Priority: must
- Stage: 6
- Related: REQ-CFG-05, REQ-OBS-05

**Acceptance criteria**

- [ ] AC1: `cleanup.policy`: `on_success`, `always` or `never`; `--keep` overrides for one run.
- [ ] AC2: Retention: `keep_last` runs per ticket and `max_age_days`.
- [ ] AC3: Cleanup removes containers, volumes, networks, worktrees and `.env` files; `--keep` keeps plan, specs, results, evidence, report and journal.
- [ ] AC4: Cleanup never touches resources without QAJitsu labels or paths outside the root.

### REQ-WS-04 · Run management commands

- Status: accepted
- Priority: should
- Stage: 6
- Related: REQ-GEN-05

**Acceptance criteria**

- [ ] AC1: `qajitsu runs <TICKET>`, `qajitsu resume <TICKET> [--run]`, `qajitsu clean <TICKET> [--run]`, `qajitsu gc`.
- [ ] AC2: A lock file prevents two processes from writing the same run; different runs of one ticket may run in parallel.
- [ ] AC3: `resume` continues from the last checkpoint in `run.json`.
