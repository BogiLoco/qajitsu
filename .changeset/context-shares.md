---
"@qajitsu/core": minor
"@qajitsu/models": minor
"@qajitsu/agents": minor
---

Shares of the context budget per source (REQ-CTX-14/AC1): `models.context_shares` (e.g. `{ diff: 0.5, knowledge: 0.2 }`,
at most 1 together) reaches every model's context profile. Over the budget, a source kind over its share is reduced
first, the furthest over first and only as far as the call needs, with the usual code reductions; shares a kind does
not use go to the others, and a call that fits is sent whole. The shares that applied are recorded in the snapshot.
