---
"@qajitsu/core": minor
"@qajitsu/steps": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/report": minor
"@qajitsu/agents": patch
"@qajitsu/cli": patch
---

Waiting for asynchronous outcomes (REQ-EXEC-46): a plan step may set `wait: { timeout_s, interval_s }`. The runtime,
in process and in the sandbox, repeats the step's actions and checks until every planned expectation of the step
holds or the time is up; the interval does not count against the case's time limit. Every round is evidence
(`<step>-wait.json`), the attempt records `wait: { waitedMs, rounds, met }` per step and `report.html` shows it; a
check not met in time fails with the last observed value, and a round that leaves out a planned check never counts as
met. The planner prompt and the plan review show the wait. The demo shop's documents are processed for two seconds
(BUG-22: never ready).
