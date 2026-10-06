---
"@qajitsu/core": minor
"@qajitsu/guard": minor
"@qajitsu/agents": patch
"@qajitsu/cli": minor
---

Projects (ADR-0006): `qj init <slug>` registers a project in `~/.qajitsu/projects/<slug>/` (runs, git cache, knowledge,
exports, logs) and links or creates its `.qa/`; `qj use`, `qj projects list|current` switch between projects. Every
command resolves its project from `--project`, `QAJITSU_PROJECT`, the ticket prefix or the active project (never the
current folder), names it on its first output line and records it in `run.json`; a run is only continued in its
project. Run folders and git mirrors default to the project home. The guard denies reads outside the run workspace.
CI registers the checked-out `.qa/` in a temporary home.
