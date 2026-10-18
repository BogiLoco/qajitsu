---
"@qajitsu/agents": patch
---

An exploratory session no longer loses its whole checklist over one finding: a finding or comment code cannot confirm
is sent back once and then dropped and journaled (`explore.claim_dropped`), and text the explorer quotes from a tool's
output is not taken as a command it claims to have run. Session S09 with qwen3 ran 13 commands and lost everything
because a finding quoted the message "qj init".
