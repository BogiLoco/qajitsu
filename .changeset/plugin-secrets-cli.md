---
"@qajitsu/cli": patch
"@qajitsu/adapter-secrets-cli": minor
---

Secret managers through their CLIs (1Password `op`, AWS Secrets Manager `aws`, GCP Secret Manager `gcloud`) are a plugin (REQ-GEN-11/AC1): `qj plugin add secrets-cli`; `qj setup` installs it for a project with `secrets.op`, `secrets.aws` or `secrets.gcp`. It loads on the first lookup of one of those schemes. The adapter takes `@qajitsu/core` as a peer dependency.
