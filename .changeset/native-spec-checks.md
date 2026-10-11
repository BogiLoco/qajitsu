---
"@qajitsu/verifier": minor
"@qajitsu/agents": patch
"@qajitsu/steps": patch
"@qajitsu/cli": patch
---

The element inventory records the platform of each id (web, Android, iOS) and the plan check accepts only ids of the
case's own platform. Specs of mobile cases are rejected statically when they use what only a browser has (`ui.as`,
`ui.select`, `ui.goto` without `mobile.deep_link_scheme`, `css:` or `role:` selectors), so the author fixes them
before the run. A mobile step may check an element before any action, since the app is open from the start.
