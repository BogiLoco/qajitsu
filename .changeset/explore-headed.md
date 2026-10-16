---
"@qajitsu/cli": patch
---

`qj explore` takes `--headed` and `--slow-mo <ms>` to watch the agent explore live, and uses the environment
`qj env up` started for the run when no `--env` is given. `qj env up` waits for Ctrl+C also when the application runs
in containers. The guard protects `ui/`, the pages recorded before planning.
