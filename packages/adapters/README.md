# Adapters

Each adapter implements one interface from `@qajitsu/core` (REQ-GEN-02) and lives in its own package `@qajitsu/adapter-<kind>-<name>`. Core never imports adapters (invariant 12). Add or implement adapters with the `/new-adapter` skill: contract tests first, scrubbed fixtures, config schema, docs.

| Package           | Interface      | Roadmap stage | Requirements            | Status      |
| ----------------- | -------------- | ------------- | ----------------------- | ----------- |
| `ticket-jira`     | TicketSource   | 1             | REQ-CTX-01              | implemented |
| `codehost-github` | CodeHost       | 1             | REQ-CTX-02, REQ-CTX-03  | implemented |
| `codehost-gitlab` | CodeHost       | 1             | REQ-CTX-02, REQ-CTX-03  | implemented |
| `secrets-env`     | SecretProvider | 1             | REQ-CFG-03              | implemented |
| `codehost-local`  | CodeHost       | 1             | REQ-NFR-04, REQ-CTX-03  | implemented |
| `env-remote`      | EnvProvider    | 3             | REQ-ENV-01, REQ-ENV-02  | planned     |
| `runner-api`      | Runner         | 3             | REQ-EXEC-04, REQ-EVD-01 | planned     |
| `evidence-local`  | EvidenceStore  | 3             | REQ-VER-05              | planned     |
| `publish-jira`    | Publisher      | 4             | REQ-PUB-01..04          | planned     |
| `runner-web`      | Runner         | 5             | REQ-EXEC-05, REQ-EVD-02 | planned     |
| `env-compose`     | EnvProvider    | 6             | REQ-ENV-03, REQ-ENV-04  | planned     |
| `runner-mobile`   | Runner         | 8             | REQ-EXEC-06, REQ-EVD-03 | planned     |

Planned later (no package yet): Jira Data Center, Bitbucket, Azure DevOps, 1Password, Vault, cloud secret managers, S3/MinIO evidence, Xray, Zephyr, device farms, Kubernetes.
