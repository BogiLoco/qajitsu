# Configuration and secrets (CFG)

How variables and secrets are layered, resolved, injected into services and kept out of everything that leaves the machine.

### REQ-CFG-01 · Layered configuration

- Status: accepted
- Priority: must
- Stage: 6
- Related: REQ-GEN-01

Five layers, each overriding the previous: framework defaults, project profile (`.qa/qa.project.yaml`), environment profile (`.qa/envs/<env>.yaml`), secrets (secret provider), run overrides (CLI flags).

**Acceptance criteria**

- [ ] AC1: Layers 1–3 are committed and contain no secrets; layer 4 never is; layer 5 is per run.
- [ ] AC2: The effective configuration (with secrets masked) is written to `run.json`.

### REQ-CFG-02 · Service variable schema and templates

- Status: accepted
- Priority: must
- Stage: 6
- Related: REQ-ENV-03

**Acceptance criteria**

- [ ] AC1: Each service declares its variables as a constant, a template (`{{svc.postgres.port}}`) or a secret reference.
- [ ] AC2: Templates resolve to dynamically assigned hosts and ports.
- [ ] AC3: Variables can be marked `overridable` for run-level overrides.

### REQ-CFG-03 · Secret providers

- Status: accepted
- Priority: must
- Stage: 1
- Related: REQ-GEN-02, INV-8

**Acceptance criteria**

- [ ] AC1: References use `secret://<provider>/<path>`; plain-text secrets in config are rejected by the schema.
- [ ] AC2: Provider `env` (environment and `.env.local`) in stage 1.
- [ ] AC3: Later providers: 1Password CLI, HashiCorp Vault, AWS/GCP Secret Manager, Doppler.

### REQ-CFG-04 · Validate configuration before start

- Status: accepted
- Priority: must
- Stage: 6
- Related: REQ-GEN-03

**Acceptance criteria**

- [ ] AC1: `qajitsu env check` lists every missing or invalid variable for the chosen environment without starting anything.
- [ ] AC2: The same validation runs before every `--build` run; failures end with exit code 3.

### REQ-CFG-05 · Generated .env files

- Status: accepted
- Priority: must
- Stage: 6
- Related: REQ-WS-03

**Acceptance criteria**

- [ ] AC1: Per-service `.env` files are written in the run workspace with permissions 0600.
- [ ] AC2: They are deleted on every exit path (success, failure, interrupt), also with `--keep`.
- [ ] AC3: `qajitsu env render` recreates them on demand.

### REQ-CFG-06 · Masking

- Status: accepted
- Priority: must
- Stage: 3
- Related: INV-8, REQ-VER-07

Secret values are masked in everything that can be read by people or models.

**Acceptance criteria**

- [ ] AC1: Every resolved secret is registered with the masker; occurrences become `***` in evidence, logs, reports, Jira comments and model context.
- [ ] AC2: Headers `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key` and configured JSON keys (`password`, `token`, ...) are always masked.
- [ ] AC3: A publish gate scans every outgoing artifact for registered secret values and blocks publishing on a hit.

### REQ-CFG-07 · Test accounts as aliases

- Status: accepted
- Priority: must
- Stage: 3
- Related: INV-8, REQ-EXEC-02

**Acceptance criteria**

- [ ] AC1: Plans and agents refer to accounts by alias (`user:standard`, `user:admin`).
- [ ] AC2: Login is performed by framework helpers (e.g. stored Playwright `storageState`); passwords never enter model context.
