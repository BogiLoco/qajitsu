---
"@qajitsu/cli": minor
---

`qj test <TICKET>` runs the whole flow in one command (fetch, plan with review, run, publish after the preview;
`--dry-run` stops before publishing). `qj env up <TICKET>` starts the application from a run's worktree without
agents or tests (`--detach` for containers). Every command, option and exit code is listed in `docs/cli/commands.md`.
