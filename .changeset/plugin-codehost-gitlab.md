---
"@qajitsu/cli": patch
"@qajitsu/adapter-codehost-gitlab": minor
---

GitLab.com and GitLab self-managed as a code host are a plugin (REQ-GEN-11/AC1): `qj plugin add codehost-gitlab`; `qj setup` installs it for a project with a `gitlab` code host. The adapter takes `@qajitsu/core` as a peer dependency; the CodeHost contract runs against the installed plugin.
