# `.qa/` template

Everything QAJitsu needs to know about a project lives in the project's own `.qa/` folder (REQ-GEN-01).
`qajitsu init` (stage 9) will generate it; until then copy this folder by hand.

| Path               | Purpose                                                                           | Requirement            | Stage |
| ------------------ | --------------------------------------------------------------------------------- | ---------------------- | ----- |
| `qa.project.yaml`  | Jira, code hosts, repos, environments, models, test types                         | REQ-GEN-01, REQ-CFG-01 | 1     |
| `envs/<name>.yaml` | Environment profiles: base URLs, allowlist, accounts, version endpoint            | REQ-ENV-01, REQ-ENV-07 | 3     |
| `auth/<alias>.ts`  | Login helpers per account alias (`user:standard`); credentials never reach agents | REQ-CFG-07             | 3     |
| `hooks/`           | `seed`, `setup`, `teardown` scripts run with the run marker                       | REQ-ENV-04, REQ-WS-02  | 6     |
| `knowledge/`       | Domain notes, glossary, OpenAPI files the agents may read                         | REQ-CTX-07             | 2     |
| `stubs/`           | Stubs for external dependencies in local builds                                   | REQ-ENV-05             | 6     |
| `qa.local.yaml`    | Personal overrides, git-ignored                                                   | REQ-CFG-01             | 6     |
