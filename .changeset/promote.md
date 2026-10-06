---
"@qajitsu/cli": minor
"@qajitsu/core": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/adapter-codehost-github": minor
"@qajitsu/adapter-codehost-gitlab": minor
---

`qj promote <TICKET>`: proposes the run's PASSED cases as a pull/merge request to the tests repository with the exact specs that passed and the approved plan's expectations, after a confirmation. Runners record each attempt's spec SHA-256 (results and journal); `CodeHost.openChangeRequest` for GitHub and GitLab; `repos.<alias>.promote_dir`.
