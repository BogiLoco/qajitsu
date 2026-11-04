---
"@qajitsu/cli": patch
"@qajitsu/adapter-runner-web": minor
---

The web runner (Playwright browsers, screenshots, video, trace, visual checks, browser logins) is a plugin (REQ-GEN-11/AC1): `qj plugin add runner-web`; `qj setup` installs it for a project with `test_types: [web]`, together with the API runner it needs. A run loads it only when the plan has web cases or a spec drives a browser. `playwright-core` is now pinned to `1.63.0` in the CLI and the runners, because the browsers are installed for one version.
