---
"@qajitsu/cli": minor
---

`qj status [--all]` shows readiness, default environment, knowledge base and each open ticket with its state and next
command; `qj note` attaches notes; `qj resume` without a ticket lists resumable work, and a run whose environment or
secrets changed after approval asks for confirmation (`RUN_CONTEXT_CHANGED` in CI). The evidence zip and `qj export`
default to the project's `exports/`; `qj evidence --serve` serves a run's report and evidence on localhost.
