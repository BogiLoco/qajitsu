---
"@qajitsu/agents": minor
"@qajitsu/core": minor
"@qajitsu/verifier": minor
"@qajitsu/guard": minor
"@qajitsu/cli": minor
---

Analyst and planner search the project's documentation with `search_docs` (all of it in the prompt for small knowledge bases). Plans cite documentation as `{"kind":"doc","chunk","quote"}`; code checks the quote verbatim against the chunk the run was given (`knowledge/chunks.json`, protected from agents) and fills in path, section, date and a "possibly outdated" warning. `knowledge.auto_sync` syncs sources before `qj plan`.
