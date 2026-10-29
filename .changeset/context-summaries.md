---
"@qajitsu/core": minor
"@qajitsu/agents": minor
"@qajitsu/cli": patch
---

Summaries as the last resort (REQ-CTX-14/AC5, REQ-CTX-17/AC2): when the budget leaves fragments out of a call whose
model cannot read handles, the `summary` model shortens them (non-pinned only, the largest four at most), keeping
numbers, identifiers and quoted expectations; the full text stays behind a handle and the reduction names the model.
Summaries are cached in the run by input hash, model and prompt version, so a repeated run reuses them; a failed
summary leaves the fragment behind its handle and is journaled. `models.context_summaries`: `no-tools` (default),
`allowed` or `off`.
