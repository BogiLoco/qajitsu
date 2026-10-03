---
"@qajitsu/core": minor
"@qajitsu/cli": minor
"@qajitsu/agents": minor
"@qajitsu/models": minor
"@qajitsu/verifier": minor
---

Stage 2: `qajitsu plan` (analyst + planner on any configured model, grounded sources, interactive review with
revise/edit, open questions), `qajitsu approve` (SHA-256 freeze) and `qajitsu doctor --models`. Adds analysis and plan
schemas (published JSON Schemas), plan versioning and diffs, the model registry (Anthropic, OpenAI, Google, Ollama,
OpenAI-compatible) with capability profiles, the guarded agent loop with structured-output repair, token budget and
cost journaling, and the plan source checker in the verifier.
