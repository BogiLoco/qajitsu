---
"@qajitsu/core": minor
"@qajitsu/agents": minor
"@qajitsu/report": minor
"@qajitsu/verifier": minor
"@qajitsu/guard": patch
"@qajitsu/models": patch
"@qajitsu/cli": minor
---

Exploratory sessions: `qj explore <TICKET> --goal "..." [--time-box <min>] [--max-steps <n>]` lets the new `explorer`
agent explore the application through browser actions QAJitsu performs and records (screenshots, video, trace,
network, console in the evidence manifest). Observations cite the recorded actions as steps to reproduce; the session
writes `explore/<session>/report.html` and `report.md` for review and never produces statuses. `qj explore promote`
turns an observation into a draft plan case with a new `observation` source kind; it runs only after approval.
`explore/` is protected from agent writes.
