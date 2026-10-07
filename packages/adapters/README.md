# Adapters

Each adapter implements one interface from `@qajitsu/core` (REQ-GEN-02, ADR-0005), runs its shared contract suite from `tests/contract/` and lives in its own package `@qajitsu/adapter-<kind>-<name>`. Core never imports adapters (invariant 12). Add or implement adapters with the `/new-adapter` skill: contract tests first, scrubbed fixtures, config schema, docs.

| Package                | Interface       | Roadmap stage | Requirements              | Status      |
| ---------------------- | --------------- | ------------- | ------------------------- | ----------- |
| `ticket-jira`          | TicketSource    | 1             | REQ-CTX-01                | implemented |
| `codehost-github`      | CodeHost        | 1             | REQ-CTX-02, REQ-CTX-03    | implemented |
| `codehost-gitlab`      | CodeHost        | 1             | REQ-CTX-02, REQ-CTX-03    | implemented |
| `secrets-env`          | SecretProvider  | 1             | REQ-CFG-03                | implemented |
| `secrets-vault`        | SecretProvider  | 1             | REQ-CFG-03                | implemented |
| `secrets-doppler`      | SecretProvider  | 1             | REQ-CFG-03                | implemented |
| `secrets-cli`          | SecretProvider  | 1             | REQ-CFG-03                | implemented |
| `codehost-local`       | CodeHost        | 1             | REQ-NFR-04, REQ-CTX-03    | implemented |
| `env-remote`           | EnvProvider     | 3             | REQ-ENV-01, REQ-ENV-02    | implemented |
| `runner-api`           | AttemptExecutor | 3             | REQ-EXEC-04, REQ-EVD-01   | implemented |
| `evidence-local`       | EvidenceStore   | 3             | REQ-VER-05                | implemented |
| `publish-jira`         | Publisher       | 4             | REQ-PUB-01..04            | implemented |
| `runner-web`           | AttemptExecutor | 5             | REQ-EXEC-05, REQ-EVD-02   | implemented |
| `env-compose`          | EnvProvider     | 6             | REQ-ENV-03, REQ-ENV-04    | implemented |
| `runner-mobile`        | AttemptExecutor | 8             | REQ-EXEC-06, REQ-EVD-03   | implemented |
| `knowledge-lancedb`    | VectorStore     | 7             | REQ-KNOW-01, ADR-0007     | implemented |
| `knowledge-chroma`     | VectorStore     | 7             | REQ-KNOW-08/AC3, ADR-0007 | implemented |
| `knowledge-confluence` | DocumentSource  | 7             | REQ-KNOW-12/AC1           | implemented |
| `messages-webhooksite` | MessageCapture  | later         | REQ-ENV-08                | implemented |

Planned later (no package yet): Bitbucket, Azure DevOps, S3/MinIO evidence, Xray, Zephyr, Kubernetes. Jira Data Center is part of `ticket-jira` and `publish-jira`; device farms are part of `runner-mobile`.
