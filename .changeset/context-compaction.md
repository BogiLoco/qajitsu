---
"@qajitsu/agents": minor
---

Compaction of long agent loops (REQ-CTX-16): before every step of a tool loop, and before every repair round, the
conversation is compacted only when the next call would not fit the budget; the oldest tool results the loop no
longer refers to are replaced by a one-line note built by code, with the full result behind a handle that
`read_context` reads (every role with a budget now gets the catalogue tools). The assembled input, the last two
results and every result the latest turn names stay whole; each compaction is journaled as `context.compacted`.
