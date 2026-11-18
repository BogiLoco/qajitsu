# Scalable execution (SCALE)

Running many tickets in parallel as a hosted or self-hosted tester farm. Out of scope for the open-source core until the single-machine flow is stable.

### REQ-SCALE-01 · Control plane and run queue

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-FLOW-01, REQ-WS-01

**Acceptance criteria**

- [ ] AC1: Runs are queued with a priority per project; each run executes on exactly one worker.
- [ ] AC2: A worker that dies marks its run BLOCKED with the reason; the run can be resumed or restarted.
- [ ] AC3: The control plane is code; it never decides verdicts.

### REQ-SCALE-02 · Worker pool and autoscaling

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-SCALE-01

**Acceptance criteria**

- [ ] AC1: Workers run as containers (first target: AWS Fargate) and scale with the queue length, between a configured minimum and maximum.
- [ ] AC2: Spot capacity can be enabled; an interrupted run is retried on another worker.
- [ ] AC3: Each worker starts clean and is destroyed after its run.

### REQ-SCALE-03 · Self-hosted worker

- Status: proposed
- Priority: must
- Stage: later
- Related: REQ-SCALE-01, REQ-CTX-10

**Acceptance criteria**

- [ ] AC1: A worker can run inside the customer's network and connect outbound only to the control plane.
- [ ] AC2: Code, environments, evidence and model calls stay inside the customer's network; only the run status and the report summary leave it, configurable down to the status only.

### REQ-SCALE-04 · Tenant isolation

- Status: proposed
- Priority: must
- Stage: later
- Related: REQ-PRJ-04, REQ-SCALE-02

**Acceptance criteria**

- [ ] AC1: Tenants never share workers, storage, caches, knowledge bases or secrets.
- [ ] AC2: Every stored object is tagged with its tenant and access is checked on each read.

### REQ-SCALE-05 · Bring your own key

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-LLM-01, REQ-CFG-03

**Acceptance criteria**

- [ ] AC1: A tenant can use its own model provider keys or its own model endpoint (local models included).
- [ ] AC2: Keys are stored in the tenant's secret provider and never logged.

### REQ-SCALE-06 · Metering and cost limits

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-LLM-07, REQ-FLOW-06, REQ-SCALE-11, REQ-SCALE-12

**Acceptance criteria**

- [ ] AC1: Per run: worker time, tokens, storage and external tool time are measured.
- [ ] AC2: Monthly limits per tenant; reaching them stops new runs with a clear message.

### REQ-SCALE-07 · Specialist planners

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-PLAN-02, REQ-PLAN-14

**Acceptance criteria**

- [ ] AC1: Optional planners per layer (API, web, mobile, security, accessibility) each propose their part of the plan.
- [ ] AC2: Their parts are merged by code into one plan; duplicates are removed and the coverage matrix (REQ-PLAN-14) is computed on the merged plan.
- [ ] AC3: The merged plan goes through the normal approval.

### REQ-SCALE-08 · Execution targets chosen per case type

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-SCALE-01, REQ-SCALE-03, REQ-GEN-10, REQ-CI-07, REQ-CI-08, REQ-ENV-06, REQ-ENV-12, REQ-LLM-07

QAJitsu offers both models: execution in its own cloud (like hosted competitors) and execution entirely in the customer's
CI or infrastructure. One plan can use several targets at once.

**Acceptance criteria**

- [ ] AC1: Supported targets: local Compose, the customer's CI (REQ-CI-08), QAJitsu cloud workers (for example AWS Fargate for API, web and CLI), machines with KVM or GPU (EC2 or Kubernetes) for Android emulators and local models, device farms, macOS hosts for iOS, and desktop machines (REQ-ENV-12).
- [ ] AC2: A project policy maps case types to targets with fallbacks (for example Android: customer CI, then EC2 with KVM, then a device farm); a case no allowed target can take is BLOCKED with the reason.
- [ ] AC3: The data policy is enforced per target: a target outside the customer's environment is used only when the project allows data to leave it.
- [ ] AC4: Results from all targets are merged into one matrix and one certificate; the target used for each case is recorded.
- [ ] AC5: Cost per target is measured and shown per run, next to the model cost (REQ-LLM-07).

### REQ-SCALE-09 · Kubernetes deployment

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-SCALE-02, REQ-SCALE-04, REQ-GEN-09, REQ-GEN-10, REQ-TUNE-04, INV-10

**Acceptance criteria**

- [ ] AC1: A Helm chart installs the control plane, model server, web console and worker definitions.
- [ ] AC2: Each run gets its own namespace with the application under test, test data and workers, labelled with the run id, with resource quotas and automatic deletion after the run.
- [ ] AC3: Workers run as Jobs per test type on matching node pools (CPU, more memory for browsers, KVM-capable for emulators, GPU for the model server).
- [ ] AC4: NetworkPolicies enforce the environment allowlist; workers cannot reach production.
- [ ] AC5: Workers scale with the queue length and node pools scale to zero when idle.
- [ ] AC6: One shared model server serves all runs; per-tenant model adapters follow REQ-TUNE-04.

### REQ-SCALE-10 · Billing units, plans and licences

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-SCALE-01, REQ-SCALE-05, REQ-SCALE-06, REQ-SCALE-08, REQ-SCALE-11, REQ-SCALE-12, REQ-VER-15, REQ-VER-19, REQ-GEN-12, INV-1

What the product must measure and enforce so it can be sold by outcome, wherever it runs. TO BE REVIEWED: plans,
prices and add-ons are hypotheses to check on the first pilots.

**Acceptance criteria**

- [ ] AC1: The billable unit is a verified ticket: a run that ended with a certificate and a GO / NO-GO decision. A run whose cases all ended BLOCKED or NOT_RUN is not billed. Billing reads the computed statuses (INV-1), never a status reported by a client.
- [ ] AC2: A verified ticket costs the same whether it ran in the QAJitsu cloud, in the customer's installation or in the customer's CI; machine time in the QAJitsu cloud is added on top or included in the plan.
- [ ] AC3: A plan defines a monthly pool of verified tickets, the price of each ticket beyond it and the number of runs at the same time; a run beyond that number waits in the queue, it never fails.
- [ ] AC4: Machine time is metered per cost class (API and web, Android on KVM hosts, iOS on macOS, device farms, desktop) and shown per run.
- [ ] AC5: Evidence retention follows the plan (30 days by default); longer retention, write-once storage (REQ-VER-19) and a compliance pack are add-ons, and an expiring plan never deletes a locked run.
- [ ] AC6: Higher plans get a faster queue (priority in REQ-SCALE-01) and a stated response time; the queue position is shown.
- [ ] AC7: With the tenant's own model keys (REQ-SCALE-05), token cost is left out of the bill and shown separately.
- [ ] AC8: Self-hosted installations and runs in the customer's CI check a licence key offline (as in REQ-GEN-12/AC2); a missing or expired licence stops new runs with the reason and never changes a status or hides existing results.

### REQ-SCALE-11 · QAJitsu model relay

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-SCALE-04, REQ-SCALE-05, REQ-SCALE-06, REQ-SCALE-10, REQ-LLM-10, REQ-FLOW-06, INV-8, INV-11
- Note: TO BE REVIEWED (owner, 2026-11-18): how QAJitsu sells its features with its own models without selling access
  to a model. Options to weigh: runs in the QAJitsu cloud only (the relay is not needed), this relay for installations
  at the customer's, or the customer's own keys (REQ-SCALE-05). A LiteLLM behind the relay can hold one virtual key per
  tenant for metering and limits. Prices, margins and plans stay out of this repository.

A customer installation that uses QAJitsu's models never gets a model key or a model address: it talks to a relay
that only accepts QAJitsu's own stage calls.

**Acceptance criteria**

- [ ] AC1: A customer installation authenticates to the relay with its licence key (REQ-SCALE-10/AC8) only; its configuration holds no model key, no model address and no model name of QAJitsu's providers.
- [ ] AC2: The relay accepts only the calls of QAJitsu's agent stages (role, stage and answer schema of the installed version) and refuses anything else, so it cannot be used as a general model endpoint.
- [ ] AC3: The relay chooses the model per role on QAJitsu's side and meters tokens and cost per tenant (REQ-SCALE-06); the tenant's usage counts against its plan, its limits stop new calls with the reason.
- [ ] AC4: Prompts and answers that pass the relay are masked like every other model call (INV-8) and are not kept beyond what the tenant's run records (REQ-VER-16); the tenant can see what was sent.
- [ ] AC5: A relay that does not answer or refuses a call makes the stage BLOCKED with the reason, never a status from a guess (INV-1).

### REQ-SCALE-12 · Plan usage instead of token prices for the customer

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-SCALE-10, REQ-SCALE-11, REQ-FLOW-06, REQ-WEB-11, INV-6
- Note: TO BE REVIEWED (owner, 2026-11-18): a customer billed per verified ticket sees the use of its plan, not token
  prices; QAJitsu's own token cost stays in its spend ledger (REQ-FLOW-06). Prices, margins and plans stay out of this
  repository.

**Acceptance criteria**

- [ ] AC1: For a tenant on a plan with QAJitsu's models, `qj budget`, `qj status` and the console (REQ-WEB-11) show the plan's use: verified tickets this month against the pool, tickets beyond it, runs at the same time; they show no token price and no cost in currency.
- [ ] AC2: The counts come from the computed statuses and certificates (REQ-SCALE-10/AC1, INV-6), never from a number a client reports.
- [ ] AC3: Ticket and month limits a tenant sets for itself (REQ-FLOW-06) can be in tickets and active minutes; token and cost limits stay available to tenants with their own model keys (REQ-SCALE-05).
- [ ] AC4: QAJitsu's operators see each tenant's real token use and cost from the spend ledger and the relay's metering next to the plan's use, so the margin of a plan can be checked; the tenant never does.
