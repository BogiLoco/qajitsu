---
"@qajitsu/cli": patch
"@qajitsu/adapter-knowledge-confluence": minor
---

Confluence as a knowledge source is a plugin (REQ-GEN-11/AC1): `qj plugin add knowledge-confluence`; `qj setup` installs it for a project with `knowledge.confluence`. The adapter takes `@qajitsu/core` as a peer dependency and passes the new DocumentSource contract, also as installed.
