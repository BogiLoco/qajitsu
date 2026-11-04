---
"@qajitsu/cli": patch
"@qajitsu/adapter-messages-webhooksite": minor
---

Message capture on webhook.site is a plugin (REQ-GEN-11/AC1): `qj plugin add messages-webhooksite`; `qj setup` installs it for a project with `messages`. A run loads it when the first inbox is needed. The adapter takes `@qajitsu/core` as a peer dependency and passes the new MessageCapture contract, also as installed.
