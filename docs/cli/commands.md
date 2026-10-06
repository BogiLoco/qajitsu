# Command reference

Every `qajitsu` (alias `qj`) command with its options and exit codes. The guides in this folder explain the flow
([fetch](fetch.md), [plan](plan.md), [run](run.md), [publish](publish.md), [build and runs](build-and-runs.md),
[web and observability](web-and-observability.md)); this page is the complete list. A contract test
(`tests/contract/cli-docs.test.ts`) fails when a command or option exists in the code but not here, or the other way round.

Exit codes follow one scheme (REQ-CI-04):

| Code | Meaning                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------- |
| `0`  | success; for commands that report test results: every case PASSED                              |
| `1`  | at least one case FAILED (or, for `audit verify`, a broken journal)                            |
| `2`  | nothing failed, but not everything passed or the command stopped at a human decision           |
| `3`  | configuration or framework error: nothing was decided, fix the setup and run the command again |

`--help` on any command prints its options; `--version` prints the version.

Every command except `init`, `use` and `projects` runs in a project (ADR-0006), resolved in this order: `--project
<slug>` (before the command, e.g. `qj --project bank fetch BANK-12`), `QAJITSU_PROJECT`, the Jira key prefix of the
ticket, the active project. The first output line names it (`Project: bank (ticket prefix BANK)`); without a project
the command stops with exit code 3.

## Setup

### `qajitsu init <slug>`

Registers a project (REQ-PRJ-02, ADR-0006): creates its home `~/.qajitsu/projects/<slug>/` (runs, git cache,
knowledge, exports, logs), links the repository's `.qa/` folder or creates one from what the repository contains
(git host, compose services, OpenAPI, test types), validates it and reports every problem, and makes it the active
project. Running it again changes nothing without `--force`; runs and knowledge are never deleted.

- `--qa-dir <path>`: the project's `.qa/` folder (default `./.qa`)
- `--jira-prefix <KEY>`: Jira key prefix that selects this project, e.g. `BANK` (repeatable; default the configured
  `jira.project_key`)
- `--yes`: do not ask; use detected values and flags
- `--force`: relink an existing project
- `--no-use`: do not make it the active project
- `--jira-url <url>`, `--project-key <key>`, `--env-url <url>`: answers when `.qa/` is created

Exit codes: `0` registered and ready, `2` registered but not ready (the problems are listed), `3` errors.

### `qajitsu use <slug>`

Makes a project the active one and shows its open work (REQ-PRJ-03).

Exit codes: `0` switched, `3` unknown project.

### `qajitsu projects list`

Every registered project with readiness, ticket prefixes, open work and its `.qa/` folder; `*` marks the active one.

- `--archived`: include archived projects (marked `archived`)

Exit codes: `0` listed, `3` errors.

### `qajitsu projects remove <slug>`

Deletes a project's home (runs, caches, knowledge base, exports, logs) after listing what goes and its size
(REQ-PRJ-07/AC3+AC4). Containers, worktrees and locks of every run are cleaned first; run journals are archived to
`<QAJITSU_HOME>/audit/<slug>/`; the project's `.qa/` folder in its repository is never touched. Without `--yes` it
asks to type the slug; non-interactively it refuses.

- `--dry-run`: only list what would be deleted and its size
- `--yes`: do not ask for confirmation
- `--delete-audit`: also delete the archived run journals

Exit codes: `0` removed or listed, `3` refused or errors.

### `qajitsu projects archive <slug>`

Hides a project from `projects list`, `status --all` and ticket prefix mapping (REQ-PRJ-07/AC5). Nothing is deleted;
an archived active project stops being active.

Exit codes: `0` archived, `3` unknown project.

### `qajitsu projects unarchive <slug>`

Shows an archived project again in lists and ticket prefix mapping.

Exit codes: `0` restored, `3` unknown project.

### `qajitsu projects current`

Prints the active project.

Exit codes: `0` printed, `3` no active project.

### `qajitsu doctor`

Checks Node.js, the project configuration, secrets, Docker and mobile tooling.

- `--models`: probe the configured model of every role (makes real model calls)
- `--online`: check access to Jira and every code host (makes real requests)

Exit codes: `0` every check passed, `3` at least one check failed.

## The flow

### `qajitsu test <ticket>`

The whole flow in one command: `fetch`, `plan` with the interactive review, `run`, and `publish` after the preview.
It stops at the human decisions: an unapproved plan stops before anything runs, a declined preview publishes nothing.

- `--pr <url>`, `--mr <url>`, `--ref <[repo=]ref>`: as for `fetch`
- `--env <profile|url>`, `--build`, `--keep`, `--set <service.VAR=value>`: as for `run`
- `--dry-run`: stop after the run; do not publish

Exit codes: the code of `run` (`0`, `1`, `2`); `2` when the plan was not approved; `3` when a stage failed.

### `qajitsu fetch <ticket>`

Fetches the ticket, its PRs/MRs, diffs and the repositories at the change's commit into a new run folder.

- `--pr <url>`: use this GitHub pull request (repeatable)
- `--mr <url>`: use this GitLab merge request (repeatable)
- `--ref <[repo=]ref>`: use this branch, tag or SHA (repeatable)

Exit codes: `0` fetched, `3` configuration, access or ticket errors.

### `qajitsu plan <ticket>`

Analyses the fetched change and writes a plan version; in a terminal, the review loop accepts, revises or edits it.

- `--run <id>`: run id (default: latest run of the ticket)
- `--revise <instruction>`: write a new plan version following this instruction

Exit codes: `0` plan written (and approved, if accepted in the review), `2` token budget exceeded, `3` errors.

### `qajitsu approve <ticket>`

Approves and freezes a plan version without the interactive loop (SHA-256 in `run.json`), e.g. in CI.

- `--run <id>`: run id (default: latest run of the ticket)
- `--version <n>`: plan version (default: latest)
- `--confirm-open-questions`: approve although the plan has open questions
- `--approver <name>`: who approves (CI: the reviewer or the `/qa approve` author)
- `--reuse-from <run>`: reuse the plan approved in this earlier run if the ticket did not change

Exit codes: `0` approved, `3` not approvable (ungrounded sources, open questions, changed ticket) or errors.

### `qajitsu run <ticket>`

Executes the approved plan: the author writes specs, static checks run, the sandbox executes them, code computes
statuses, gates, auditor and canary run, reports are written.

- `--run <id>`: run id (default: latest run of the ticket)
- `--env <profile|url>`: environment profile from `.qa/envs` or a URL (default: `environments.default`)
- `--build`: build the application from the fetched worktrees
- `--keep`: with `--build`, keep containers and worktrees after the run
- `--set <service.VAR=value>`: with `--build`, override an overridable service variable (repeatable)
- `--fix-check`: with `--build`, verify a bug fix (REQ-VER-11): after this run, a sibling run builds the commit the
  change branched from and runs the same approved plan and specs; every case marked `reproduces` must be FAILED before
  the fix and PASSED with it. Both results appear side by side in the report and the Jira comment.

With `--fix-check` the exit code is the run's when the fix is verified, `1` when a reproduction case still fails
with the fix, `2` when the check is not conclusive (e.g. the test passes before the fix) and `3` on errors.

Exit codes: `0` every case PASSED and the publish gates hold, `1` any case FAILED, `2` otherwise (BLOCKED, FLAKY,
NOT_RUN, NEEDS_REVIEW, failed gates), `3` configuration or framework errors. Ctrl+C stops the environment and exits
with `130`.

### `qajitsu publish <ticket>`

Publishes the results comment and attachments to the ticket after a confirmed preview.

- `--run <id>`: run id (default: latest run of the ticket)
- `--auto-publish`: skip the preview (CI); recorded in `run.json`

Exit codes: `0` published, `2` preview declined, `3` refused by the gates or failed.

## Exploratory testing

### `qajitsu explore <ticket>`

An exploratory session (REQ-EXEC-15): the explorer agent explores the application towards a goal through browser
actions that QAJitsu performs and records (a screenshot after each action, video, trace, network and console, all in
the evidence manifest). It reports observations with steps to reproduce for a person to assess, never statuses, and
writes `explore/<session>/report.html` and `report.md` for review. Needs a fetched run (`qajitsu fetch`).

- `--goal <text>`: what to explore (required), e.g. "checkout around the terms change"
- `--run <id>`: run id (default: latest run of the ticket)
- `--env <profile|url>`: environment profile from `.qa/envs` or a URL (default: `environments.default`)
- `--time-box <minutes>`: stop after this many minutes (default 10), enforced by code
- `--max-steps <n>`: stop after this many browser actions (default 40), enforced by code

Exit codes: `0` the session ran (whatever it observed), `2` the environment is not healthy, `3` errors.

### `qajitsu explore promote <ticket>`

Turns an observation into a draft web case in a new plan version, with the observation as its source and the recorded
actions as steps. It runs only after the plan is approved.

- `--session <id>`: exploratory session, e.g. `S01` (required)
- `--observation <id>`: observation, e.g. `O1` (required)
- `--run <id>`: run id (default: latest run of the ticket)

Exit codes: `0` plan version written, `3` unknown session or observation, approved plan, or other errors.

## Results and evidence

### `qajitsu evidence <ticket>`

Shows statuses, failed assertions, evidence files and cURL commands; opens the report, videos or a trace.

- `--run <id>`: run id (default: latest run of the ticket)
- `--failed`: only cases that did not pass
- `--case <id>`: only this case
- `--trace <case>`: open the Playwright trace of a case
- `--no-open`: print only, do not open the report, videos or traces
- `--serve`: serve the run's `report/` and `evidence/` on 127.0.0.1 until Ctrl+C (never `env/`, `repos/` or the
  journal; REQ-PRJ-10/AC4)
- `--port <n>`: with `--serve`, the port (default: a free one)

Exit codes: `0` shown, `3` errors.

### `qajitsu logs <ticket>`

Shows the structured event log of a run.

- `--run <id>`: run id (default: latest run of the ticket)
- `--follow`: keep printing new events while the run is running
- `--stage <stage>`: only this stage, e.g. `run` or `plan`
- `--agent <role>`: only this agent, e.g. `planner`
- `--case <id>`: only events of this case

Exit codes: `0` shown, `3` errors.

### `qajitsu pull <ticket>`

Downloads the evidence zip of a run (e.g. from CI) from the ticket and verifies it.

- `--run <id>`: run id (required)

Exit codes: `0` pulled and verified, `2` pulled but the hashes differ, `3` errors.

### `qajitsu export <ticket>`

Writes pipeline artifacts of a run: `report.html`, `junit.xml`, the matrix and the evidence zip.

- `--run <id>`: run id (default: latest run of the ticket)
- `--out <dir>`: output folder, e.g. `qa-artifacts` (default: `<project-home>/exports/<TICKET>/<RUN>/`)

Exit codes: the run's code (`0`, `1`, `2`) so a pipeline step can fail on it, `3` errors.

### `qajitsu map`

Application map over every run: tested and never-tested screens and endpoints (`map.json`, `map.html`).

- `--out <dir>`: output folder (default: `<project-home>/exports/qa-map`)
- `--openapi <file>`: OpenAPI document of the known endpoints (default: from the newest worktree)

Exit codes: `0` written, `3` errors.

## Knowledge base

Documents a project adds on demand, searched by the analyst and planner with cited sources (REQ-KNOW, ADR-0007). One
knowledge base per project in `<project-home>/knowledge/`: a LanceDB store, `sources.yaml` and `index.json`.
Documentation that fits `knowledge.full_context_tokens` is used without embeddings; above it retrieval is hybrid
(vectors from `knowledge.embedding` plus keywords). Content is masked before it is stored; `.env` files, keys and
certificates are never indexed.

### `qajitsu knowledge add [paths...]`

Registers files and folders (recursive) as sources and indexes them: Markdown, text, HTML, DOCX, PDF (with a text layer) and OpenAPI (one chunk
group per operation); other files are skipped and listed. Adding a registered path again only processes new or
changed files and prints counts of added, updated, unchanged, skipped and removed files (REQ-KNOW-02).

- `--include <glob>`: only files matching this glob (repeatable)
- `--exclude <glob>`: skip files matching this glob (repeatable)
- `--tag <tag>`: tag the documents of this source (repeatable)
- `--qa-knowledge`: add the project's `.qa/knowledge/` folder (REQ-KNOW-01/AC2)
- `--yes`: confirm sending document text to a cloud embedding model (REQ-KNOW-09/AC2)

Exit codes: `0` indexed, `3` errors or no confirmation for a cloud model.

### `qajitsu knowledge sync`

Re-processes changed files (by content hash), removes chunks of deleted files and adds new files of every registered
source (REQ-KNOW-04).

- `--dry-run`: only show what would change
- `--yes`: confirm sending document text to a cloud embedding model

Exit codes: `0` synced, `3` errors.

### `qajitsu knowledge remove <source-or-file>`

Removes a source and all its chunks, or one file, which is then excluded from its source so `sync` does not bring it
back (REQ-KNOW-03/AC1).

Exit codes: `0` removed, `3` unknown source or file.

### `qajitsu knowledge reset`

Empties the knowledge base after confirmation (REQ-KNOW-03/AC2).

- `--keep-sources`: keep the registered sources for a later `sync`
- `--yes`: do not ask for confirmation

Exit codes: `0` emptied, `3` not confirmed or errors.

### `qajitsu knowledge reindex`

Stores every chunk again with the configured embedding model and retrieval mode; needed after changing
`knowledge.embedding` (REQ-KNOW-08/AC2).

- `--yes`: confirm sending document text to a cloud embedding model

Exit codes: `0` rebuilt, `3` errors.

### `qajitsu knowledge list`

Sources with file and chunk counts, tags and last sync, plus the embedding model, retrieval mode, store and size on
disk (REQ-KNOW-05/AC1, REQ-KNOW-07/AC3).

Exit codes: `0` listed, `3` errors.

### `qajitsu knowledge search <query>`

Prints the ranked chunks agents would get, with source path, section, date and chunk id, to check retrieval quality
(REQ-KNOW-05/AC2).

- `--tag <tag>`: only documents with this tag (repeatable)
- `--limit <n>`: number of results (default 5)

Exit codes: `0` searched, `3` errors.

## Environment

### `qajitsu env check`

Lists every missing or invalid variable of the environment profile and the `--build` configuration; starts nothing.

- `--env <profile>`: environment profile (default: `build.profile` or `environments.default`)

Exit codes: `0` complete, `3` something is missing or invalid.

### `qajitsu env up <ticket>`

Starts the application from a fetched run's worktree exactly as `run --build` would, without agents or tests, and
prints the service URLs. Ctrl+C stops it; the worktree stays for a later `run`.

- `--run <id>`: run id (default: latest run of the ticket)
- `--set <service.VAR=value>`: override an overridable service variable (repeatable)
- `--detach`: leave the containers running (containers only); remove them with `qajitsu clean`

Exit codes: `0` started and stopped (or detached), `2` the environment did not start (the service logs are named),
`3` configuration errors.

### `qajitsu env render <ticket>`

Recreates the per-service `.env` files of a run (0600; they contain secrets and are removed by `clean`).

- `--run <id>`: run id (default: latest run of the ticket)

Exit codes: `0` written, `3` errors.

## Runs

### `qajitsu runs <ticket>`

Lists the runs of a ticket with stage, status, results and retention.

- `--keep <id>`: mark a run keep: `gc`, `clean --project` and `work reset --delete` never remove it or its evidence
  (REQ-PRJ-10/AC6)
- `--unkeep <id>`: let a run follow the retention policy again

Exit codes: `0` listed (also when there are none), `3` errors or an unknown run.

### `qajitsu status`

The active project at a glance (REQ-PRJ-05): configuration readiness, default environment, knowledge base, and every
ticket with unfinished work, its state ("plan v2 waiting for approval", "results not published", "interrupted during
run") and the command that continues it, with the ticket's latest notes. Computed from the run folders;
`context.json` in the project home is only an index of it.

- `--all`: every project
- `--rebuild`: rebuild `context.json` from the run folders

Exit codes: `0` shown, `3` errors.

### `qajitsu note <ticket> <text>`

Attaches a note to a ticket; `status` shows it next to the ticket's work. Known secrets in the text are masked.

Exit codes: `0` stored, `3` empty note or errors.

### `qajitsu resume [ticket]`

Continues a run from its last checkpoint; stops at plan approval and publishing. Without a ticket it lists the
resumable work of the project with the command for each. When the environment or a secret changed after the plan was
approved, the run does not continue silently: interactively it asks for confirmation, otherwise it stops with
`RUN_CONTEXT_CHANGED` (REQ-PRJ-06/AC3).

- `--run <id>`: run id (default: latest run of the ticket)
- `--env <profile|url>`: environment for the run stage
- `--build`: build the environment for the run stage

Exit codes: the code of the stage it continued (`plan` or `run`); `0` when the run is complete, `2` when it waits for
a person (approval or publish), `3` errors.

### `qajitsu clean [ticket]`

Removes containers, volumes, networks, worktrees and `.env` files of a run; results, evidence and reports stay.
With `--project` it applies retention (`cleanup.keep_last`, `cleanup.max_age_days`) to every run of the project and
removes git mirrors not fetched within `max_age_days` (REQ-PRJ-07/AC2).

- `--run <id>`: run id (default: latest run of the ticket)
- `--all`: every run of the ticket
- `--project`: every run and git mirror of the project instead of one ticket
- `--dry-run`: with `--project`, only list what would be removed

Exit codes: `0` cleaned (runs in use by another process are skipped and listed), `3` errors.

### `qajitsu work reset <ticket>`

Closes the open work of a ticket (REQ-PRJ-07/AC1): `status` and `resume` stop offering it, commands without `--run`
refuse the closed run with `RUN_CLOSED`, and the next `fetch` starts a new run. Old runs stay and can still be named
with `--run`.

- `--delete`: also remove the ticket's runs (except runs marked keep); journals are archived first

Exit codes: `0` closed, `3` errors.

### `qajitsu gc`

Applies retention (`cleanup.keep_last`, `cleanup.max_age_days`) to every ticket; journals are archived first.

- `--dry-run`: only list the runs that would be removed

Exit codes: `0` done, `3` errors.

## Models and integrity

### `qajitsu bench`

Benchmarks a model on the seeded-bug cases: detection, false FAILED, BLOCKED, plan acceptance, time and cost.
Makes real model calls; never in PR CI.

- `--model <ref>`: the model to measure, e.g. `ollama/qwen2.5-coder:32b` (required)
- `--role <role>`: only this role uses the model (default: every role)
- `--cases <file>`: benchmark cases (default: `.qa/bench.yaml`)
- `--out <dir>`: where the JSON report goes (default: `<project-home>/exports/bench-results`)
- `--knowledge <mode>`: `on` (default; the knowledge base when the project has one), `off`, or `compare`: every case
  runs without and then with the knowledge base, and the report shows the difference in detection, false FAILED,
  BLOCKED and plans accepted without edits (REQ-KNOW-11)

Exit codes: `0` the benchmark completed (whatever the scores), `3` configuration errors.

### `qajitsu audit verify [ticket]`

Checks the hash chain of run journals, also archived ones.

- `--run <id>`: run id (default: latest run of the ticket)
- `--all`: every run of the ticket
- `--file <journal>`: verify this journal file instead

Exit codes: `0` every journal intact, `1` a chain is broken, `3` errors.

## Observability

### `qajitsu telemetry export <ticket>`

Sends journal events not exported yet as OTLP traces, logs and metrics.

- `--run <id>`: run id (default: latest run of the ticket)

Exit codes: `0` exported, `3` telemetry not configured or the export failed.

### `qajitsu metrics`

Metrics over every run, as Prometheus text or JSON, for dashboards and alerts.

- `--format <format>`: `prometheus` (default) or `json`
- `--out <file>`: write to a file atomically, e.g. for the node_exporter textfile collector

Exit codes: `0` written, `3` errors.

## CI

### `qajitsu ci detect`

Works out the trigger: a labelled PR/MR, a `/qa` comment, a manual run or a Jira dispatch; writes `$GITHUB_OUTPUT`.

- `--label <name>`: PR/MR label that starts QAJitsu (default: `qa-agent`)
- `--paths <glob...>`: only when a changed file matches one of these globs
- `--format <format>`: `json` (default) or `env` (shell-safe export lines)

Exit codes: `0` detected (also "nothing to do"; read the output), `3` errors.

### `qajitsu ci comment <ticket>`

Posts the plan or the results to the PR/MR as one updatable comment and sets the status check.

- `--change <url>`: the PR/MR (required)
- `--run <id>`: run id (default: latest run of the ticket)

Exit codes: `0` posted, `3` errors.

### `qajitsu ci publish-plan <ticket>`

Posts the latest plan version to the Jira ticket as one updatable comment.

- `--run <id>`: run id (default: latest run of the ticket)

Exit codes: `0` posted, `3` errors.
