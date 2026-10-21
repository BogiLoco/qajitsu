# Private model tuning (TUNE)

Enterprise, later. A customer's own QA model, tuned on its approved work inside its own infrastructure. Verdicts still come only from code (INV-1): tuning can improve plans and tests, never results.

### REQ-TUNE-01 · Training data from the audit trail, with consent

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-VER-16, REQ-CFG-06, REQ-PRJ-04

**Acceptance criteria**

- [ ] AC1: Training records are derived from the audit trail: plan versions and approved plans, generated tests, runner results, healer fixes, auditor downgrades, fix verification labels (REQ-VER-11).
- [ ] AC2: Collection is opt-in per project, recorded with who enabled it, and can be withdrawn; a withdrawal removes the project's records from future datasets.
- [ ] AC3: Secrets and personal data are removed before a record is stored; only human-approved items are used.
- [ ] AC4: Every dataset is versioned and hashed.

### REQ-TUNE-02 · Tuning cycle with a gate and shadow mode

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-TUNE-01, REQ-SKILL-04, REQ-LLM-06

**Acceptance criteria**

- [ ] AC1: A scheduled cycle builds the dataset, trains an adapter on an open-weight base model, evaluates it on a frozen benchmark and compares it with the current model.
- [ ] AC2: The new adapter is promoted only if it passes the quality gate (REQ-SKILL-04/AC2) and every adversarial test.
- [ ] AC3: Before promotion it runs in shadow mode: people see the current model's plans while the results are compared.
- [ ] AC4: Promotion is versioned with one-step rollback; the model and adapter version is recorded with every run.
- [ ] AC5: The cost of each cycle is estimated before it starts and reported after it ends.

### REQ-TUNE-03 · Training providers and data residency

- Status: proposed
- Priority: must
- Stage: later
- Related: REQ-TUNE-02, REQ-SCALE-03, REQ-GEN-02

**Acceptance criteria**

- [ ] AC1: A training provider adapter supports the customer's own GPUs, the customer's own cloud account (for example SageMaker, Vertex AI, Azure) and external GPU services.
- [ ] AC2: External services are allowed only when the project policy explicitly lets data leave the customer's environment; the default is denied.
- [ ] AC3: The provider, region and data location of each cycle are recorded.

### REQ-TUNE-04 · Shared base model with per-tenant adapters

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-TUNE-02, REQ-SCALE-04

**Acceptance criteria**

- [ ] AC1: In the hosted service one base model can serve the adapters of many tenants.
- [ ] AC2: Each request is checked against the tenant that owns the adapter; adapters and datasets are never shared between tenants.

### REQ-TUNE-05 · Licences of base models

- Status: proposed
- Priority: must
- Stage: later
- Related: REQ-TUNE-02

**Acceptance criteria**

- [ ] AC1: Each base model lists its licence; a model whose licence does not allow the intended commercial use cannot be selected.
- [ ] AC2: Outputs of third-party hosted models are used as training data only where the provider's terms allow it; otherwise only human-written and runner-produced records are used.
