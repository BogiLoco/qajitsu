---
"@qajitsu/agents": patch
"@qajitsu/cli": patch
"@qajitsu/core": patch
"@qajitsu/report": patch
---

An exploratory session whose explorer keeps making claims code refuses no longer ends in error with nothing kept:
its last answer is corrected by code (refused claims become not done, items an action ran get it), marked "corrected
by code" and journaled. Session S10 with qwen3 ran ten commands, including a plan, and lost them all this way. A group
command followed by a subcommand it does not have says "unknown command" again (`qj baseline list`), not "too many
arguments".
