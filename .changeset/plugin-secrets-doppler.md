---
"@qajitsu/cli": patch
"@qajitsu/adapter-secrets-doppler": minor
---

Doppler as a secret provider is a plugin (REQ-GEN-11/AC1): `qj plugin add secrets-doppler`; `qj setup` installs it for a project with `secrets.doppler`. It loads on the first `secret://doppler/` lookup. The adapter takes `@qajitsu/core` as a peer dependency.
