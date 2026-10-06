# 0006. Projects live in project homes under the QAJitsu home

- Status: Accepted
- Date: 2026-10-06
- Related: REQ-PRJ-01, REQ-PRJ-02, REQ-PRJ-03, REQ-PRJ-04, REQ-PRJ-10, REQ-WS-01, REQ-CTX-04, INV-2, INV-8, INV-10

## Context

Until now a "project" was implicit: the CLI walked up from the current directory to the first `.qa/qa.project.yaml`,
kept runs in `~/.qa-runs` and git mirrors in `~/.qa-cache/git`, shared by every project on the machine. One person
testing systems of several clients needs projects that are explicit, isolated and switchable, with everything a
project owns in one place (REQ-PRJ-*). There are no existing installations to migrate.

## Decision

- **QAJitsu home** is `~/.qajitsu/` (`QAJITSU_HOME` overrides). It holds `config.yaml` (the active project, no
  secrets) and `projects/<slug>/`.
- **Project home** `projects/<slug>/` holds `project.yaml` (slug, absolute path of the linked `.qa/` folder, Jira key
  prefixes), `runs/`, `cache/git/`, `knowledge/`, `exports/`, `logs/` and `context.json`. Slugs match
  `^[a-z][a-z0-9-]{1,39}$`; every path is built from validated slugs, ticket keys and run ids.
- **The project of a command** is resolved once, before the command runs, in this order: `--project`,
  `QAJITSU_PROJECT`, the Jira key prefix of the command's ticket (a prefix mapped to two projects is an error), the
  active project. If none applies the command fails with exit code 3; QAJitsu never falls back to the current
  directory. The resolved project's `.qa/` folder is the configuration; its run root (`<project-home>/runs/`) and git
  cache (`<project-home>/cache/git/`) are the defaults unless `.qa/` sets them explicitly.
- **A run belongs to one project**: `run.json` records it at `fetch`, and a run opened under another project is
  refused. Locks stay per run, so runs of different projects run in parallel.
- **Isolation** follows from the layout: agent tools are rooted in the run workspace (the guard denies everything
  else), secrets, environments, allowlists and models come from the run's project configuration, and the knowledge
  base of a project is read only by its runs.
- **CI** registers the checked-out repository's `.qa/` as a project in a temporary `QAJITSU_HOME`
  (`qj init <slug> --qa-dir .qa --yes`); no registry outlives the job.

## Consequences

- `qj init <slug>`, `qj use`, `qj projects list|current` are new; every command can take `--project`.
- Tests and CI register a project before running commands.
- Moving or archiving a project is moving its home; evidence paths in manifests are relative to the run workspace.
