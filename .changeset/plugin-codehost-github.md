---
"@qajitsu/cli": patch
"@qajitsu/adapter-codehost-github": minor
---

GitHub and GitHub Enterprise Server as a code host are a plugin (REQ-GEN-11/AC1): `qj plugin add codehost-github`; `qj setup` installs it for a project with a `github` code host. The adapter takes `@qajitsu/core` as a peer dependency; the CodeHost contract, which now accepts an asynchronously built host, runs against the installed plugin.
