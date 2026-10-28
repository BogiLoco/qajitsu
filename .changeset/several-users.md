---
"@qajitsu/steps": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/verifier": minor
"@qajitsu/core": patch
"@qajitsu/cli": minor
---

Several users in one web case (REQ-EXEC-62): `ui.session(name)` opens another browser session, logged in as the test
account the case names under that key in its data (`buyer: user:standard`), with its own cookies and storage, and
switches between sessions; each holds its own pool account, screenshots and the action log name their session.
Snapshots note whether a page exposes the application's test hook, and a plan expecting `state.*` from pages without
one is flagged. Demo shop: messages between shoppers with BUG-19 (DEMO-14).
