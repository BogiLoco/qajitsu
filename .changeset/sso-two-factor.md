---
"@qajitsu/core": minor
"@qajitsu/steps": minor
"@qajitsu/adapter-env-remote": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/adapter-runner-web": minor
"@qajitsu/verifier": minor
"@qajitsu/agents": patch
"@qajitsu/cli": minor
---

Automated logins for test environments (REQ-EXEC-55): accounts can carry a TOTP seed (`totp: secret://...`) whose
codes QAJitsu computes when they are typed (`ui.fillSecret(sel, alias, "totp")`, `{{totp}}`, `QAJITSU_TOTP` for login
scripts); `ui.fillCode(sel)` types the code of the e-mail or SMS the step's plan expects (`message.code` pattern), and
no message in time fails that check; `login: { browser: ... }` runs SSO through the identity provider's pages with
redirects, keeps only the application's own session, loads only allowlisted provider origins and reuses one login per
account and run; `test_headers` sends the application's test mechanisms (a captcha bypass) to its own origin only.
Captchas are never solved. The planner's answer gets missing evidence filled by code; plan flags about texts the
recorded pages show differently no longer block approval. Demo shop: a fictional identity provider with TOTP.
