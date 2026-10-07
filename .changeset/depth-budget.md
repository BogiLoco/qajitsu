---
"@qajitsu/core": minor
"@qajitsu/agents": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/cli": minor
---

Test depth, estimate and budget (REQ-PLAN-08): `qj plan --depth smoke|standard|full` keeps cases by risk (priority) and records the depth and why each case is in or out; every run starts with an estimate of execution time and model use from the project's past runs; `budget: { max_minutes, max_cost_usd }` makes the remaining cases NOT_RUN with the reason. plan.md also shows manual steps, messages, visual checks and locales.
