---
"@qajitsu/core": minor
"@qajitsu/report": minor
"@qajitsu/cli": minor
---

Environment readiness for the ticket (REQ-ENV-13): `environments.readiness` lists where each repository's deployed
commit is read (a JSON endpoint: a version endpoint, the deployments API of GitHub or GitLab, Argo CD; or a script of
`.qa/hooks/`) and the checks before the first case (HTTP status and JSON values for health, migrations and feature
flags, limited to ticket labels where needed; account logins; scripts). The deployed commit must be the change or
contain it, checked in the run's worktree. Not ready: every case is BLOCKED with the failed checks and their observed
values, after waiting for the deployment when `wait` is set. `qj run --env-not-confirmed "<reason>"` runs anyway:
results are marked "environment not confirmed" and `qj release` never counts them as verified. The report goes to
`run.json`, `report.html`, the Jira comment, the certificate and, per `comment`, a ticket comment. In pull mode a
ticket is parked in its start status until its environment is ready.
