---
"@qajitsu/core": minor
"@qajitsu/models": minor
"@qajitsu/agents": minor
"@qajitsu/cli": patch
---

Context budgets (REQ-LLM-15, REQ-CTX-12, REQ-CTX-14): every model has a context profile (working range below the
window, answer reserve, token margin per family, provider counting for Anthropic, cache style, compact style for small
windows and local models; `working_range` and `context_style` per model in `models.providers`). Calls that fit are
sent as they are; otherwise the context manager reduces by code: on-demand material and what matches nothing of the
task go behind handles, large diffs and logs are trimmed with their structure kept, then the least relevant fragments
follow; pinned fragments are never touched and a call they alone overflow is refused. Agents read handles with
`read_context` and find them with `search_context`; reads are journaled. Snapshots carry the budget, the catalogue and
the relevance ranking; `qj logs` shows them in one line. Tool results are wrapped in the run's data blocks.
