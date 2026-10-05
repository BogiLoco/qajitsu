---
"@qajitsu/core": minor
"@qajitsu/agents": minor
"@qajitsu/verifier": minor
"@qajitsu/cli": patch
---

Tests repository awareness: a repository with `role: tests` is checked out at its default branch on every fetch
(marked `role: tests` in `run.json`, excluded from the deployed-version check). The planner sees an index of its
tests and may list `existing_coverage` in the plan; every claim must name a real file and test title and real
criteria (checked by code). The author gets the repository's selector strategy, page-object selectors and
convention documents.
