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

## Setup

### `qajitsu init`

Creates `.qa/` for the current repository from detected values (git host, compose services, OpenAPI, test types).

- `--yes`: do not ask; use detected values and flags
- `--force`: replace an existing `.qa/qa.project.yaml`
- `--jira-url <url>`: Jira base URL (empty: tickets from files)
- `--project-key <key>`: Jira project key
- `--env-url <url>`: URL of the test environment

Exit codes: `0` created, `3` the configuration exists (without `--force`) or cannot be written.

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

Exit codes: `0` every case PASSED and the publish gates hold, `1` any case FAILED, `2` otherwise (BLOCKED, FLAKY,
NOT_RUN, NEEDS_REVIEW, failed gates), `3` configuration or framework errors. Ctrl+C stops the environment and exits
with `130`.

### `qajitsu publish <ticket>`

Publishes the results comment and attachments to the ticket after a confirmed preview.

- `--run <id>`: run id (default: latest run of the ticket)
- `--auto-publish`: skip the preview (CI); recorded in `run.json`

Exit codes: `0` published, `2` preview declined, `3` refused by the gates or failed.

## Results and evidence

### `qajitsu evidence <ticket>`

Shows statuses, failed assertions, evidence files and cURL commands; opens the report, videos or a trace.

- `--run <id>`: run id (default: latest run of the ticket)
- `--failed`: only cases that did not pass
- `--case <id>`: only this case
- `--trace <case>`: open the Playwright trace of a case
- `--no-open`: print only, do not open the report, videos or traces

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
- `--out <dir>`: output folder (required), e.g. `qa-artifacts`

Exit codes: the run's code (`0`, `1`, `2`) so a pipeline step can fail on it, `3` errors.

### `qajitsu map`

Application map over every run: tested and never-tested screens and endpoints (`map.json`, `map.html`).

- `--out <dir>`: output folder (default: `<project>/qa-map`)
- `--openapi <file>`: OpenAPI document of the known endpoints (default: from the newest worktree)

Exit codes: `0` written, `3` errors.

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

Lists the runs of a ticket with stage, status and results.

Exit codes: `0` listed (also when there are none), `3` errors.

### `qajitsu resume <ticket>`

Continues a run from its last checkpoint; stops at plan approval and publishing.

- `--run <id>`: run id (default: latest run of the ticket)
- `--env <profile|url>`: environment for the run stage
- `--build`: build the environment for the run stage

Exit codes: the code of the stage it continued (`plan` or `run`); `0` when the run is complete, `2` when it waits for
a person (approval or publish), `3` errors.

### `qajitsu clean <ticket>`

Removes containers, volumes, networks, worktrees and `.env` files of a run; results, evidence and reports stay.

- `--run <id>`: run id (default: latest run of the ticket)
- `--all`: every run of the ticket

Exit codes: `0` cleaned (runs in use by another process are skipped and listed), `3` errors.

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
- `--out <dir>`: where the JSON report goes (default: `<project>/bench-results`)

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
