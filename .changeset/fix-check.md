---
"@qajitsu/core": minor
"@qajitsu/verifier": minor
"@qajitsu/report": minor
"@qajitsu/agents": patch
"@qajitsu/cli": minor
---

Bug fix verification (REQ-VER-11): plan cases can be marked `reproduces`; `qj run <TICKET> --build --fix-check` runs
the approved plan on the fix, then creates a sibling run on the commit the change branched from (`GitRepos.mergeBase`)
with the same approved plan (reused by SHA-256) and the same specs. `evaluateFixCheck` verifies the fix only when every
reproduction case is FAILED before and PASSED after with identical specs; the report and the Jira comment show both.
