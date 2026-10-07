---
"@qajitsu/core": minor
"@qajitsu/steps": minor
"@qajitsu/verifier": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/adapter-evidence-local": minor
"@qajitsu/adapter-messages-webhooksite": minor
"@qajitsu/agents": minor
"@qajitsu/cli": minor
---

Message capture (REQ-ENV-08): `messages:` (webhook.site, hosted or self-hosted) gives every case its own inbox; plan steps can expect a message (`expect.message`: to, subject, body, within_s), specs use `inbox.address()` and `inbox.wait()`, the trusted runtime matches against the plan, keeps the masked message as evidence and fails the step when none arrives; inboxes are deleted when the run ends. Spec type checks now read the `@qajitsu/steps` sources in the monorepo.
