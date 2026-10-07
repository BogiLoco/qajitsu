---
"@qajitsu/core": minor
"@qajitsu/adapter-ticket-jira": minor
"@qajitsu/report": minor
"@qajitsu/cli": minor
---

Release readiness report (REQ-PUB-09): `qj release <fixVersion>` (or `--sprint <name>`) collects every ticket of the release from Jira (JQL on the project's fix version or sprint) or the file source (`fixVersions`, `sprint`), evaluates each ticket's latest executed run with the same code as `qj publish` and writes `exports/releases/<name>.md`: status counts, open cases, tickets without a run (never ready) and runs whose gates fail (untrusted). `--publish <KEY>` posts it as a comment after a preview. `TicketSource.findTickets` is a new optional method.
