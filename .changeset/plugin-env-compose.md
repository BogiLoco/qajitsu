---
"@qajitsu/cli": patch
"@qajitsu/adapter-env-compose": minor
---

Starting the application from the worktree (`qj run --build`, `qj env up`) with Docker Compose or managed processes is a plugin (REQ-GEN-11/AC1): `qj plugin add env-compose`; `qj setup` installs it for a project with `build` or compose services. Cleanup and `qj status` skip container work when the plugin is not installed, because without it QAJitsu started none. The EnvProvider contract runs against the installed plugin.
