---
"@qajitsu/cli": patch
"@qajitsu/adapter-secrets-vault": minor
---

HashiCorp Vault as a secret provider is a plugin (REQ-GEN-11/AC1): `qj plugin add secrets-vault`; `qj setup` installs it for a project with `secrets.vault`. The CLI loads it on the first `secret://vault/` lookup, so other references never need it. The adapter takes `@qajitsu/core` as a peer dependency.
