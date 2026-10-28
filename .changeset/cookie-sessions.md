---
"@qajitsu/core": minor
"@qajitsu/steps": minor
"@qajitsu/adapter-env-remote": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/adapter-runner-web": minor
"@qajitsu/verifier": minor
"@qajitsu/report": patch
"@qajitsu/agents": patch
"@qajitsu/cli": patch
---

Logins for real web applications (REQ-EXEC-67): the HTTP login can use the `Set-Cookie` of its response as the
session (no `token_path`), login scripts can print `cookies` or a Playwright `storage_state`, and `web_session:
{ storage: cookies }` makes `ui.as(alias)` load them for the application's origin only. `ui.fillSecret(selector, alias,
"password" | "username")` types an account's secret into a login form: the runner resolves it, screenshots black the
field out, and specs, agents, evidence and the journal see only the mask. Traces kept as evidence are now masked,
including sensitive headers and cookies the application set during the test. `zip`/`unzip` moved to
`@qajitsu/core` (still exported by `@qajitsu/report`). Demo shop: sign-in with an HttpOnly cookie and BUG-18 (DEMO-13).
