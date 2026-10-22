# Audit trail and test certificates

A QAJitsu run records everything that influenced its verdict, with hashes (the audit trail, REQ-VER-16), and can end
with one signed certificate over all of it (REQ-VER-15). Anyone with the run folder or its audit export and the
project's public key can check, offline and without QAJitsu, that nothing was changed after the run (REQ-VER-21).

## What a certificate proves, and what it does not

A valid certificate proves:

- **Nothing changed after the run.** Every covered file has the size and SHA-256 it had when the certificate was
  issued: the ticket as fetched, the change, every plan version and the frozen plan, the generated tests, raw runner
  output, evidence and its manifest, auditor and canary records, matrix and reports. Journals and logs only grow, so
  the part written until then is covered; later lines (publishing, for example) do not invalidate it.
- **Who approved what.** The approved plan's SHA-256 and every approval step (person or model, decision, plan version,
  time) are in the certificate; `qj audit verify` also checks them against the journal.
- **What ran, where and with what.** Commit SHAs and change references, tool and model versions, container image
  digests, the tested environment and its version, the status of each case and the GO / NO-GO decision.
- **What the agents saw and said.** Every prompt, answer and tool call of every model is in `journal/agents.jsonl`,
  masked, and covered like any other file.
- **Who issued it.** The signature verifies with the public key of the project's signing key.

A certificate does **not** prove:

- that the plan covered every risk of the change. It proves what was tested, not that it was enough; plan review,
  coverage of the ticket and the change (REQ-PLAN-14), the auditor and the canary are the controls for that;
- that the application behaves the same in production, or at another version than the one recorded;
- that a person read the evidence. Approvals are recorded; reviews of results are a separate step;
- anything about files it does not list. Check the subject list; `run.json` itself, `env/` (secrets), `audit/` and the
  copies made when publishing (`report/published/`, `report/media/`) are not covered;
- that the signing key was kept secret. Keep it in the secret provider and rotate it if in doubt.

## Producing one

```bash
qj audit keygen                    # Ed25519 key: private key for the secret provider, public key in .qa/keys/
# .qa/qa.project.yaml:
#   certificate: { signing_key: secret://env/QAJITSU_SIGNING_KEY, required: true }
qj audit trail SHOP-482            # everything behind the verdict, with hashes, and the gaps
qj audit certify SHOP-482          # or: qj publish, which issues it before the comment
qj audit export SHOP-482           # one zip for an auditor: files, trail, SHA256SUMS, README, certificate
qj verify-report <run folder or zip> --key .qa/keys/<id>.pub
```

A run gets no certificate while its audit trail has gaps (a missing file, a hash that does not match, a broken journal,
a model call without its stored prompt and answer), nor when its results, evidence, plan or journal changed after an
earlier certificate. With `required: true`, such a run is not published. Reports are rendered again by code before
certifying, so a hand-edited report is never certified, and rendering them again later keeps the certificate valid.

Keys rotate: create a new key, keep the old `*.pub` files in `.qa/keys/`, and old certificates still verify.

## Format (REQ-VER-15/AC5, REQ-VER-21/AC2)

Everything below is enough to write a verifier; [`tools/verify-certificate.mjs`](../../tools/verify-certificate.mjs)
is one in about 100 lines of Node.js built-ins, tested against real certificates.

### Files

| Path (relative to the run folder)   | What                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `certificate/certificate.dsse.json` | the certificate: a DSSE envelope                                                                            |
| `certificate/<key id>.pub`          | the signer's public key, for convenience (trust only keys you were given)                                   |
| `audit/trail.json`                  | the audit trail: every file with category and SHA-256, the gaps, records                                    |
| `evidence/manifest.json`            | evidence files with SHA-256, kind, case and step (REQ-VER-05)                                               |
| `journal/events.jsonl`              | event journal; each line's `prev` is the SHA-256 of the line before                                         |
| `journal/agents.jsonl`              | one line per model call; the journal's `model.usage` event holds `exchangeSha256`, the SHA-256 of that line |
| `SHA256SUMS` (in the export only)   | `sha256sum -c` format for every file of the export                                                          |

### Envelope

[DSSE](https://github.com/secure-systems-lab/dsse): `{ payloadType, payload, signatures: [{ keyid, sig }] }`.
`payloadType` is `application/vnd.in-toto+json`; `payload` is the statement as base64 JSON; `sig` is the base64 Ed25519
signature over the pre-authentication encoding

```
"DSSEv1" SP len(payloadType) SP payloadType SP len(payload) SP payload
```

with lengths as decimal byte counts and `payload` the decoded bytes. `keyid` is the hex SHA-256 of the public key's SPKI
DER encoding. The certificate id is `qjc-` followed by the first 20 hex digits of the SHA-256 of the decoded payload.

### Statement

An [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md), schema
[`schemas/test-certificate.v1.schema.json`](../../schemas/test-certificate.v1.schema.json):

- `_type`: `https://in-toto.io/Statement/v1`
- `predicateType`: `https://qajitsu.dev/attestation/test-certificate/v1`
- `subject`: one entry per covered file, sorted by `name` (the run-relative path):
  `{ name, digest: { sha256 }, annotations: { bytes, prefix? } }`. Without `prefix` the file must have exactly `bytes`
  bytes and that SHA-256; with `prefix: true` (journals `journal/*.jsonl`, logs `logs/**/*.log`) its first `bytes`
  bytes must have that SHA-256.
- `predicate`: `ticket`, `runId`, `issuedAt`, `files` (number of subjects), `merkleRoot`, `repos` (commit SHA and change
  per repository), `plan` (approval of the frozen plan: version, SHA-256, approver, time), `approvals` (every step),
  `planSha256`, `manifestSha256`, `matrixSha256`, `reportSha256`, `statuses` (per case, computed by code), `decision`,
  `versions`, `images` (container, image, image id), `environment`, `codeAccess`.

`report/report.html` is hashed with its certificate section emptied: the text between `<!--qajitsu:certificate-->`
and `<!--/qajitsu:certificate-->` is removed before hashing, because the section is stamped after the certificate is
issued. A verifier must accept in that section only nothing or exactly the stamp QAJitsu renders for this certificate.

### Merkle root (REQ-VER-15/AC4)

The shape of RFC 6962 over the subjects sorted by name:

- leaf: `SHA-256(0x00 ‖ name ‖ 0x00 ‖ sha256-hex ‖ 0x00 ‖ bytes-decimal)`
- node: `SHA-256(0x01 ‖ left ‖ right)`, where the left part holds the largest power of two of leaves smaller than
  the number of leaves
- one leaf is its own root; no leaves give `SHA-256("")`

One changed byte in any covered file changes its leaf and so the root.

### Checking

1. Read the envelope; check `payloadType`.
2. Find a trusted public key whose key id equals `signatures[0].keyid`; verify the signature over the encoding above.
3. Decode the statement; check `_type`, `predicateType` and the schema.
4. Recompute the Merkle root from `subject` and compare it with `predicate.merkleRoot`.
5. For each subject, hash the file (the whole file, the first `bytes` bytes, or the report with its section emptied)
   and compare size and digest. Report every changed and missing file.

`qj verify-report` does all of this and also reads an audit export zip directly; inside a project it trusts
`.qa/keys/*.pub` as well as `--key`.

## Audit trail (REQ-VER-16)

`qj audit trail` writes `audit/trail.json`:

```json
{
  "schema": 1,
  "ticket": "SHOP-482",
  "runId": "20261003-1046-k7f3",
  "complete": true,
  "gaps": [],
  "records": {
    "repos": {},
    "approval": {},
    "approvals": [],
    "versions": {},
    "images": [],
    "environment": {}
  },
  "files": [{ "category": "plan", "path": "plan/plan.approved.yaml", "sha256": "…" }]
}
```

Categories: `ticket`, `change`, `context`, `plan`, `tests`, `runner`, `evidence`, `checks`, `report`, `journal`,
`agents`, `explore`, `run`, `certificate`, `other`. The trail is computed from the files every time; an edited
`trail.json` changes nothing. Secrets are masked before any file is written, so hashes cover exactly the stored,
masked content (REQ-VER-16/AC3). Each line of `journal/agents.jsonl` holds the stage, role, model, provider, the model
version the provider reported, the request (system prompt and messages, images as their SHA-256 and size), the answer
with every tool call (arguments) and tool result, and the tokens.
