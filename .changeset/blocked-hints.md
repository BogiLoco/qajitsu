---
"@qajitsu/core": minor
"@qajitsu/verifier": minor
"@qajitsu/agents": minor
"@qajitsu/cli": minor
---

Why a case was BLOCKED (REQ-VER-13): after the run, the triage model suggests the likely cause of every BLOCKED case
(spec, plan, environment, tooling, configuration) with a next step, citing the error, spec lines, steps, evidence or
logs. Code keeps only hints whose citations exist; they are printed under the result table, shown in the matrix and
report (`checks/blocked.json`) and never change a status. Switched with `verification.triage`.
