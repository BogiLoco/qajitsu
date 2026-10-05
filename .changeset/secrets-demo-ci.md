---
"@qajitsu/core": minor
"@qajitsu/cli": minor
"@qajitsu/adapter-secrets-vault": minor
"@qajitsu/adapter-secrets-doppler": minor
"@qajitsu/adapter-secrets-cli": minor
"@qajitsu/adapter-runner-mobile": patch
---

Secret managers besides `env` under `secrets:` in `qa.project.yaml`: HashiCorp Vault KV v2 (`secret://vault/<path>#<field>`),
Doppler (`secret://doppler/<NAME>`), 1Password, AWS Secrets Manager and Google Secret Manager through their CLIs
(`secret://op/...`, `secret://aws/...`, `secret://gcp/...`). Their own tokens come from `secret://env/...`. `pnpm demo`
runs the whole flow on the demo-shop offline; CI reviews new dependencies and audits the installed tree.
