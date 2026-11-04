---
"@qajitsu/cli": patch
"@qajitsu/adapter-runner-api": minor
---

The API runner, which drives every lane of a run, is a plugin (REQ-GEN-11/AC1): `qj plugin add runner-api`, installed by `qj init` and `qj setup` for every project. The adapter takes `@qajitsu/core` and `@qajitsu/steps` as peer dependencies. The AttemptExecutor contract runs on the production sandbox started from the installed plugin's own folder. The web and mobile runners are now needed only for the test types that use them.
