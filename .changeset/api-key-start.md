---
"@qajitsu/cli": minor
"@qajitsu/models": minor
"@qajitsu/agents": minor
---

Start with an API key only (REQ-LLM-09): `qj init` finds provider keys by name and proposes Claude models with a
spending limit; Claude models have built-in context windows and prices; the run's cost adds up over every stage, an
unknown price shows as unknown, and `budget.max_cost_usd` stops model stages; `qj doctor --models` names a rejected
key by its variable.
