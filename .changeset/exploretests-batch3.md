---
"@qajitsu/cli": patch
"@qajitsu/adapter-env-compose": minor
---

`qj run` without `--env` or `--build` uses the environment `qj env up` started for the run while it answers, as
`qj explore` already did; it said nothing and ran every case against `environments.default`, which ended BLOCKED.

`qj status` lists the environments still running for the project's runs, with their URLs and the `qj clean` command
that stops them; detached demo environments ran unnoticed for days.
