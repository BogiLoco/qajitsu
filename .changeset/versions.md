---
"@qajitsu/report": minor
"@qajitsu/cli": minor
---

Versions (REQ-GEN-03/AC4+AC5, REQ-OBS-10): `qj doctor` ends with the versions of QAJitsu, the system, Node.js, git, Docker and Compose, Playwright and each browser, Java, the Android SDK, emulator, Appium and its drivers (missing tools the project needs are errors with the install command) and of the application under test (git mirror, default branch and latest run per repository; with `--online` the remote and the version deployed on each environment; where the mobile binary comes from). Every run records the tool and model versions it used in `run.json`; `report.html`, the ticket comment, `qj runs` and `qj evidence` show them; `qj promote` keeps them in the pack, and `qj regression` and `qj run --fix-check` list the versions that differ.
