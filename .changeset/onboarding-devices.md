---
"@qajitsu/core": minor
"@qajitsu/cli": minor
"@qajitsu/adapter-env-remote": minor
"@qajitsu/adapter-runner-mobile": minor
"@qajitsu/adapter-publish-jira": patch
---

Onboarding through `.qa/` only: login scripts in `.qa/auth/` (`login: { script: auth/<file> }`) for form, cookie
or SSO logins, and `hooks.setup` / `hooks.teardown` around every run (a failing setup makes every case BLOCKED).
`mobile.devices` runs mobile cases on several emulators or farm sessions in parallel, one case at a time per
device. Publishers honour an aborted signal before sending anything. `qj run` lists every configuration problem.
