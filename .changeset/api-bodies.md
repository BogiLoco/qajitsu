---
"@qajitsu/steps": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/verifier": minor
"@qajitsu/core": minor
"@qajitsu/agents": patch
---

API bodies beyond JSON (REQ-EXEC-45): specs send `multipart/form-data` (text fields and files of the plan by key),
`application/x-www-form-urlencoded`, raw binary from a plan file and plain text through `client.multipart()`,
`client.form()`, `client.binary()` and `client.text()`. A response that is a file (an attachment, or a type that is not
text or JSON) is kept as evidence with its SHA-256 and checked by the existing `download.*` expectations; the call's
record points to the file instead of inlining it, and form fields, text bodies and cURL lines are masked. The static
checks require literal plan file keys, and an API request in a step satisfies a planned download. The author prompt
explains the helpers. `plannedFields` moved to `@qajitsu/core` (re-exported by the verifier).
