---
"@qajitsu/adapter-files": minor
"@qajitsu/core": minor
"@qajitsu/cli": patch
"@qajitsu/adapter-ticket-jira": minor
"@qajitsu/adapter-publish-jira": minor
"@qajitsu/adapter-testcases": minor
---

New core package `@qajitsu/adapter-files` (REQ-GEN-11/AC1). It holds the adapters that work from local files: tickets
and their workflow, the publisher and bug tracker that write files, resolved bugs for the knowledge base, and manual
cases from CSV or Excel. They moved out of `ticket-jira`, `publish-jira` and `testcases`, which no longer export them,
so those packages can become plugins while a project on files keeps working without any plugin. `@qajitsu/core` now
exports the helpers these adapters share: `bugMarkdown`, `componentTag`, `toImportedCase` and `MAX_IMPORTED_CASES`.
