---
"@qajitsu/core": minor
"@qajitsu/steps": minor
"@qajitsu/adapter-runner-web": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/verifier": minor
"@qajitsu/agents": patch
---

Installable web apps and offline mode (REQ-EXEC-65): a web case can allow service workers with
`browser.service_workers: true` (Chromium only, where every request of the worker stays on the allowlist; elsewhere the
case is BLOCKED with the reason), a step can go offline and back with `ui.setOffline(true|false)`, and `manifest.*`
checks the page's web app manifest (`name`, `short_name`, `start_url`, `display`, number of `icons`) and whether a
service worker controls the page (`manifest.controlled`). The author's prompt now also lists `ui.advanceTime()`.
