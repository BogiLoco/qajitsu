---
"@qajitsu/agents": patch
"@qajitsu/cli": patch
---

The browser explorer is shown the first calls to make (`explore_look`, then `explore_goto` to `/`) in its prompt and
when it answers before acting; qwen3 answered three times without acting before and the session ended with nothing.
Browser sessions print each action, rejected answer and observation in the terminal as they happen, as command-line
sessions do.
