---
"@qajitsu/cli": patch
"@qajitsu/core": minor
"@qajitsu/models": minor
"@qajitsu/agents": patch
---

Found by exploratory testing of every qj command:

- `qj projects` alone lists the projects (it printed help and exited 3), and the list reports the same readiness as
  `qj status` (it said "ready" for a project whose tools were missing).
- Requests to Ollama and OpenAI-compatible providers wait up to `timeout_s` of the provider (default 1800 s) instead
  of Node's 5-minute limit for the first byte, which cut off slow thinking models mid-session.
- A command-line explorer that answers before acting is shown the first command to run, taken from its checklist;
  qwen3 with a long checklist answered three times without any command before.
- `qj approve` lists the expectations it cannot check with one marker each (they were prefixed twice).
