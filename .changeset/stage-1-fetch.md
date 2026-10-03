---
"@qajitsu/core": minor
"@qajitsu/cli": minor
"@qajitsu/guard": minor
"@qajitsu/adapter-ticket-jira": minor
"@qajitsu/adapter-codehost-github": minor
"@qajitsu/adapter-codehost-gitlab": minor
"@qajitsu/adapter-codehost-local": minor
"@qajitsu/adapter-secrets-env": minor
---

Stage 1: `qajitsu fetch <TICKET>` creates a run folder with the ticket snapshot, discovered PRs/MRs/branches, diffs,
review comments and git worktrees at the exact SHA. Adds Jira Cloud and file ticket sources, GitHub (incl. GHES and
GitHub App), GitLab (incl. self-managed) and local code hosts, the `env` secret provider, the run event log and masked
arguments in the guard journal. `createJournal` now requires a masking function.
