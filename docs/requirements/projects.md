# Projects and working context (PRJ)

QAJitsu serves several projects on one machine. Each project has its own home with runs, caches, knowledge and
exports; a run sees only its own project, and the user can switch projects and continue work at any time.

### REQ-PRJ-01 · Project home and data layout

- Status: accepted
- Priority: must
- Stage: 2
- Related: REQ-WS-01, REQ-CTX-04, REQ-PRJ-04

Everything a project owns lives under one folder, so it can be inspected, backed up or removed as a unit.

**Acceptance criteria**

- [ ] AC1: QAJitsu home is `~/.qajitsu/` (overridable with `QAJITSU_HOME`); it holds only global settings (`config.yaml`) and `projects/<slug>/`.
- [ ] AC2: A project home contains `project.yaml` (identity, link to the project's `.qa/` config, Jira key prefixes), `runs/` (run workspaces, REQ-WS-01), `cache/` (git mirrors and code indexes, REQ-PRJ-08), `knowledge/` (REQ-KNOW-01), `context.json` (REQ-PRJ-05), `exports/` (REQ-PRJ-10) and `logs/`.
- [ ] AC3: Project slugs match `^[a-z][a-z0-9-]{1,39}$`; paths are built only from validated slugs, ticket keys and run ids.
- [ ] AC4: No file of one project is written outside its project home, except the project's own `.qa/` folder when the user asks `init` to create it.
- [ ] AC5: Global settings never contain secrets; secrets stay `secret://` references resolved per project (REQ-CFG-03).

### REQ-PRJ-02 · Project initialisation (`qj init`)

- Status: accepted
- Priority: must
- Stage: 2
- Related: REQ-PRJ-01, REQ-GEN-01, REQ-GEN-03

**Acceptance criteria**

- [ ] AC1: `qj init <slug>` creates the project home and registers the project; it runs interactively, or non-interactively with flags (`--qa-dir`, `--jira-prefix`, `--yes`) for scripts and CI.
- [ ] AC2: It links an existing `.qa/` folder of a repository, or creates one from `templates/qa/` when asked.
- [ ] AC3: It validates the configuration (as `qj doctor` does) and reports every problem before finishing; an invalid project is registered but marked as not ready.
- [ ] AC4: The new project becomes the active project unless `--no-use` is given.
- [ ] AC5: Re-running `init` on an existing slug changes nothing without `--force`, and never deletes runs or knowledge.
- [ ] AC6: The knowledge base starts empty; nothing is indexed during `init` (REQ-KNOW-01).

### REQ-PRJ-03 · Active project and switching

- Status: accepted
- Priority: must
- Stage: 2
- Related: REQ-PRJ-05, REQ-PRJ-06

**Acceptance criteria**

- [ ] AC1: `qj use <slug>` sets the active project; `qj projects list` shows all projects with readiness and open work; `qj projects current` prints the active one.
- [ ] AC2: The project for a command is resolved in this order: `--project` flag, `QAJITSU_PROJECT`, Jira key prefix mapping (e.g. `BANK-12` → `bank`), active project. If none applies, the command fails with exit code 3.
- [ ] AC3: A Jira prefix mapped to more than one project is an error; QAJitsu never guesses.
- [ ] AC4: Every command prints the resolved project in its first output line and records it in `run.json` and the journal.
- [ ] AC5: After `qj use`, a short summary of the project's open work is shown (REQ-PRJ-05).
- [ ] AC6: A run is bound to its project when it starts; switching the active project never affects running or paused runs.
- [ ] AC7: Runs of different projects may execute at the same time (separate processes); locks are per run (REQ-WS-04).

### REQ-PRJ-04 · Isolation between projects

- Status: accepted
- Priority: must
- Stage: 2
- Related: REQ-VER-03, REQ-KNOW-06, INV-2, INV-8, INV-10

A run sees only its own project. This protects confidentiality when one person tests systems of different clients.

**Acceptance criteria**

- [ ] AC1: Agent file tools are limited by the guard to the run workspace and the read-only parts of its own project home; paths in other projects are denied and journaled.
- [ ] AC2: `search_docs` and `search_code` query only the run's project knowledge base and the run's repositories.
- [ ] AC3: Secrets, environment profiles, URL allowlists and model settings are resolved from the run's project only.
- [ ] AC4: Adversarial test: an agent in project A that asks for a file, document or secret of project B is denied, and nothing from B appears in A's prompts, evidence or reports.

### REQ-PRJ-05 · Project status: what is in the project and what is in progress

- Status: accepted
- Priority: must
- Stage: 3
- Related: REQ-WS-01, REQ-WS-04, REQ-KNOW-05

After a switch the user sees at once what was being done and what to do next.

**Acceptance criteria**

- [ ] AC1: `qj status` shows for the active project: configuration readiness, default environment, knowledge base summary (sources, documents, last sync), and work in progress.
- [ ] AC2: Work in progress lists each open ticket with its last run, current pipeline stage, state (e.g. "plan v2 waiting for approval", "run paused at env", "results not published") and the next command to continue.
- [ ] AC3: Status is computed by code from `run.json` files; `context.json` is only an index and can be rebuilt with `qj status --rebuild`.
- [ ] AC4: The user can attach notes to a ticket (`qj note <TICKET> "..."`); notes are shown in status and kept with the ticket's runs.
- [ ] AC5: `qj status --all` shows the same summary for every project.

### REQ-PRJ-06 · Continue after switching

- Status: accepted
- Priority: must
- Stage: 3
- Related: REQ-WS-04, REQ-PRJ-05

**Acceptance criteria**

- [ ] AC1: `qj resume [TICKET]` continues the latest unfinished run of the ticket from its last checkpoint; without a ticket it lists resumable work in the active project.
- [ ] AC2: Switching projects, closing the terminal or restarting the machine loses no state: plans, approvals, results and notes are on disk.
- [ ] AC3: A run whose approved plan, environment or secrets changed while it was paused does not continue silently; it asks to re-approve or start a new run.

### REQ-PRJ-07 · Start fresh and clean up

- Status: accepted
- Priority: should
- Stage: 6
- Related: REQ-WS-03, REQ-OBS-05

**Acceptance criteria**

- [ ] AC1: `qj work reset <TICKET>` closes the ticket's open work so the next command starts a new run; old runs are kept or deleted according to `--delete` and the retention policy.
- [ ] AC2: `qj clean --project [<slug>]` applies retention to all runs and caches of a project.
- [ ] AC3: `qj projects remove <slug>` deletes the project home after confirmation; `--dry-run` lists what would be deleted (runs, caches, knowledge base) and its size.
- [ ] AC4: Removing a project never deletes the repository's `.qa/` folder, test data in the system under test, or the audit log unless explicitly requested with separate flags.
- [ ] AC5: `qj projects archive <slug>` keeps the project home but hides it from lists and prefix mapping.

### REQ-PRJ-08 · Code cache per project

- Status: accepted
- Priority: should
- Stage: 3
- Related: REQ-CTX-04, REQ-PRJ-01

Code fetched for runs is kept per project so repeated runs on the same commit are fast.

**Acceptance criteria**

- [ ] AC1: Git mirrors live in `<project-home>/cache/git/`; each run gets worktrees at the change's SHA (REQ-CTX-04).
- [ ] AC2: Code indexes, when built, are cached by `<repo>@<sha>` and reused by later runs on the same commit.
- [ ] AC3: Caches follow the retention policy and are removed with the project.

### REQ-PRJ-09 · Export and import of a project profile

- Status: accepted
- Priority: could
- Stage: later
- Related: REQ-PRJ-01, REQ-KNOW-02

**Acceptance criteria**

- [ ] AC1: `qj projects export <slug>` writes the project profile and the list of knowledge sources (not the index, never secrets) to one file.
- [ ] AC2: `qj projects import <file>` recreates the project on another machine; the knowledge base is rebuilt with `qj knowledge sync`.

### REQ-PRJ-10 · Evidence, reports and exports stay in the project

- Status: accepted
- Priority: must
- Stage: 3
- Related: REQ-PRJ-01, REQ-PRJ-04, REQ-VER-05, REQ-PUB-02, REQ-PUB-06, INV-7

Everything a run produces as proof belongs to the run's project and is found there, also after switching projects.

**Acceptance criteria**

- [ ] AC1: Evidence (screenshots, videos, traces, request/response pairs, logs), `results/`, `report/` and the manifest are written only inside the run workspace `<project-home>/runs/<TICKET>/<RUN_ID>/`.
- [ ] AC2: Evidence zips and other exports are written to `<project-home>/exports/` (or a path given with `--out`); never to the current directory by default.
- [ ] AC3: Evidence pulled from CI runs (`qj pull`) lands in the matching project's `runs/`, resolved by the ticket key prefix (REQ-PRJ-03).
- [ ] AC4: `qj evidence <TICKET>` and the local viewer for reports and videos open files of the resolved project only; the viewer serves only that run workspace and binds to localhost.
- [ ] AC5: The `evidence-local` store refuses paths outside the run workspace; the manifest stores paths relative to it, so a run folder can be moved or archived as a unit.
- [ ] AC6: Retention and `qj projects remove` treat evidence like other run data; `--keep` keeps evidence of the selected runs (REQ-WS-03).
