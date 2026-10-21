---
"@qajitsu/verifier": minor
"@qajitsu/report": minor
"@qajitsu/core": minor
"@qajitsu/cli": minor
---

Every run ends with a GO / NO-GO / NO DECISION decision computed by code from the statuses and the plan's
priorities, with the cases that caused it, in the terminal, matrix, report, junit, `qj evidence`, `qj export` and the
ticket comment; `decision:` in the project config can tolerate statuses of lower priority cases (REQ-PUB-10).
An invalid configuration now names every problem in its message for every command, and `qj doctor` reports it once.
