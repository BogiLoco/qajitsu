---
"@qajitsu/cli": patch
"@qajitsu/adapter-evidence-s3": minor
---

Write-once storage on S3 Object Lock is a plugin (REQ-GEN-11/AC1): `qj plugin add evidence-s3`; `qj setup` installs it for a project with `archive`. The adapter takes `@qajitsu/core` as a peer dependency and passes the new EvidenceArchive contract, also as installed.
