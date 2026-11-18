---
"@qajitsu/core": minor
"@qajitsu/models": minor
"@qajitsu/agents": minor
"@qajitsu/verifier": minor
"@qajitsu/cli": minor
---

The audit through a provider batch (REQ-VER-06/AC4, REQ-LLM-12/AC3): with `verification.auditor_delivery: batch` the
run's audit goes to the auditor provider's batch API (Anthropic, OpenAI, Google) at half price. Until it is collected
with `qj audit collect` (or `qj publish`), every PASSED case shows as NEEDS_REVIEW ("audit pending") and nothing is
published; the collected answer is checked and applied like an immediate audit, and a failed, expired or invalid
answer is a failed audit. A provider without a batch API audits at once. `ResolvedModel.batch` (`ModelBatch`) offers
batches to other work too.
