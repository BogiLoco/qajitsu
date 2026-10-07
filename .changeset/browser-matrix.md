---
"@qajitsu/core": minor
"@qajitsu/verifier": minor
"@qajitsu/report": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/adapter-runner-web": minor
"@qajitsu/cli": minor
---

Browser and viewport matrix (REQ-EXEC-13): `web.matrix` runs web cases in every browser × viewport combination with results and evidence per combination; `combineStatuses` makes a case PASSED only when every combination passed; a missing browser is BLOCKED with the install command; matrix, report and Jira comment show the status per combination.
