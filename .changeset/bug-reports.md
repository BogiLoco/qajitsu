---
"@qajitsu/cli": minor
"@qajitsu/core": minor
"@qajitsu/report": minor
"@qajitsu/adapter-publish-jira": minor
---

`qj bug <TICKET>`: reports FAILED cases as Jira bugs after showing similar open bugs; the report is rendered by code from the run (steps, expected vs actual, version, environment, evidence by hash, hint), masked, labelled `qajitsu` and linked to the tested ticket, or the failure is linked to an existing bug. New `BugTracker` interface with Jira (Cloud, Data Center) and file implementations.
