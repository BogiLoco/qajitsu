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
- Related: REQ-LLM-07, REQ-FLOW-06

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
