---
"@qajitsu/cli": patch
"@qajitsu/adapter-runner-mobile": minor
---

The mobile runner (Appium, Android emulators, device farms) is a plugin (REQ-GEN-11/AC1): `qj plugin add runner-mobile`; `qj setup` installs it for a project with mobile tests, together with the API runner it needs. A run with mobile cases loads it before any lane starts. `webdriverio` is pinned to `9.32.0`. A new device factory contract on a fake Appium client runs on the source and on the installed plugin.
