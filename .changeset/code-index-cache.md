---
"@qajitsu/agents": minor
"@qajitsu/cli": patch
---

The tests-repository index is cached per project by `<repo>@<sha>` in `<project-home>/cache/index/` and reused by later runs on the same commit; corrupt entries are rebuilt, and `qj clean --project` removes entries unused for `cleanup.max_age_days`.
