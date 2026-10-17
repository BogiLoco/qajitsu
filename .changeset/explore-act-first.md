---
"@qajitsu/agents": minor
"@qajitsu/cli": minor
"@qajitsu/models": minor
"@qajitsu/core": minor
---

Every explorer (browser and command line) must act before it summarises: a summary while the session has no recorded
action is rejected with the tools still available, and a session whose agent never acts ends with `error` and an
empty summary (REQ-EXEC-15/AC8, REQ-EXEC-24/AC8). Ollama models accept `think: true|false` in their capabilities,
passed to Ollama, because thinking models such as Qwen3 call tools only when it is set.
