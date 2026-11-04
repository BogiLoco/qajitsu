---
"@qajitsu/core": minor
"@qajitsu/steps": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/cli": minor
---

Shared environments (REQ-EXEC-54). `execution.rate_limit` limits the requests per second to one host and the cases at
once, across every lane of a run. A `429` or `503` with `Retry-After` is waited out and retried, only for a request
that is safe to repeat: a GET, or a request of a plan step with `idempotency_key: true`, which also carries an
`Idempotency-Key` that stays the same on retries. Every retry is evidence. A case still rate limited after its budget
is BLOCKED as "rate limited", never FAILED or PASSED.
