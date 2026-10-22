---
"@qajitsu/cli": minor
"@qajitsu/core": minor
"@qajitsu/agents": minor
"@qajitsu/verifier": minor
"@qajitsu/report": minor
"@qajitsu/adapter-env-compose": minor
---

Audit trail, signed test certificates, test code quality gate and human spec review.

- REQ-VER-16: every model call is stored masked in `journal/agents.jsonl` (prompt, answer, tool calls with arguments
  and results, provider, model version, tokens) with its hash in the journal; compose environments record container
  image digests; `qj audit trail` lists every file of a run with its SHA-256 and the gaps; `qj audit export` writes
  one secret-scanned zip with `SHA256SUMS` and a README.
- REQ-VER-15: `certificate.signing_key` (Ed25519, from the secret provider; `qj audit keygen`) signs an in-toto
  statement in a DSSE envelope over the run's complete audit trail with an RFC 6962-style Merkle root; `qj publish`
  and `qj audit certify` issue it, `report.html` and the Jira comment show it, `certificate.required` stops a
  publication without one; `qj verify-report` checks a run folder or export offline with keys from `--key` or
  `.qa/keys/`. Reports render deterministically so a certificate stays valid. Schema:
  `schemas/test-certificate.v1.schema.json`.
- REQ-VER-21: `tools/verify-certificate.mjs`, a verifier with Node.js built-ins only, and the format guide.
- REQ-VER-23: generated specs pass a test code quality gate (constant or skippable assertions, swallowed errors,
  disabled cases, whole-page checks) before they run.
- REQ-VER-24: `qj run --review-specs` and `spec_review` let a person accept or send back each generated spec;
  `qj review-spec` decides without a terminal.
- `qj init` names the same missing tools as `qj doctor`; cases not chosen with `--cases` stay NOT_RUN when the
  environment fails.
