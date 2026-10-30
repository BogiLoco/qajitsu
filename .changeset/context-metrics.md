---
"@qajitsu/report": minor
"@qajitsu/models": minor
"@qajitsu/cli": minor
---

Context metrics and policies (REQ-CTX-18): `qj metrics` exports per role and model the estimated input tokens by
fragment kind, reductions by action, assembled inputs, `read_context` and `search_context` calls and the prompt cache
hit rate (`contextUsage` / `mergeContextUsage` in `@qajitsu/report`). `qj bench --context <policies>` runs every case
once per context policy (`default`, `full`, `compact`, `range=<tokens>`, combined with `+`), reports detection, plan
quality, tokens, cost and time per policy and names the cheapest policy that keeps the best quality. The model
registry takes a `contextPolicy` that wins over every model's own working range and style.
