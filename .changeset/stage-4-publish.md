---
"@qajitsu/core": minor
"@qajitsu/cli": minor
"@qajitsu/report": minor
"@qajitsu/adapter-publish-jira": minor
"@qajitsu/adapter-ticket-jira": minor
---

Stage 4: `qajitsu publish` recomputes statuses and gates from disk, shows a preview, then posts the results comment
(ADF on Jira Cloud, wiki markup on Data Center) with the evidence zip and updates the same comment when a run is
published again. Adds `qajitsu evidence` for local reproduction, the Jira Data Center ticket source and the
`publish` configuration section. The `Publisher` interface now takes a rendered comment and returns a result with
uploaded and skipped attachments.
