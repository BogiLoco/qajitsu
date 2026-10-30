---
"@qajitsu/agents": patch
---

Smarter last reductions, found by dogfooding the planner with a local model: over the budget, the least relevant
fragment per token goes behind a handle first (a large page recording before a smaller, denser analysis); fragments no
larger than their catalogue line are never put behind a handle; and the catalogue's own lines count in the budget, so a
call never ends over it.
