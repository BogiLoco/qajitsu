---
"@qajitsu/cli": minor
---

`qj init` installs the official plugins the new project's configuration needs (REQ-GEN-11/AC1), such as the Jira
plugins for a Jira project, so the usual flow needs no extra step. A plugin that cannot be installed makes the project
NOT READY, with the reason.
