---
"@qajitsu/cli": patch
"@qajitsu/adapter-publish-jira": minor
---

Publishing to Jira (the result comment, attachments, bug reports, the workflow and attachment downloads for `qj pull`) is a plugin (REQ-GEN-11/AC1): `qj plugin add publish-jira`; `qj setup` installs it for a project with `jira.type: cloud` or `datacenter`. Publishing to files stays in the core. The CLI loads it on first use; the Publisher contract runs against the installed plugin.
