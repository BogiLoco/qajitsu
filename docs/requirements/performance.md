# Performance testing (PERF)

An agent plans and writes performance tests for a change, tool-agnostic (k6, Gatling, JMeter, Locust and others), helped by skills per tool. Thresholds are frozen in the plan and the verdict is computed by code from the tool's raw metrics. Details still to be refined.

### REQ-PERF-01 · Performance plan with frozen thresholds

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-PLAN-02, REQ-PLAN-06, REQ-PLAN-13

**Acceptance criteria**

- [ ] AC1: The planner proposes performance scenarios when the change touches performance-relevant areas: load, stress, spike or soak, with target endpoints or flows.
- [ ] AC2: Every scenario has thresholds (for example p95 latency, error rate, throughput) taken from the ticket, project SLOs or project defaults, with the source shown.
- [ ] AC3: Thresholds, load profile and duration are approved by a person and frozen with the plan.

### REQ-PERF-02 · Tool-agnostic performance runners

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-PERF-01, REQ-GEN-11, REQ-SKILL-01, REQ-EXEC-35
- Note: TO BE REVIEWED: REQ-EXEC-35 (external runners) also names k6; decide whether k6 lives there or only here.

**Acceptance criteria**

- [ ] AC1: A performance runner plugin interface (REQ-GEN-11); first adapter k6, then Gatling, JMeter and Locust.
- [ ] AC2: Scripts are generated per tool from the same scenario description, with a skill per tool (REQ-SKILL-01).
- [ ] AC3: Existing scripts of the project (for example JMeter `.jmx` files) can be imported and run unchanged.
- [ ] AC4: Static checks before running: the load profile and target hosts in the script match the frozen plan.

### REQ-PERF-03 · Verdict from raw metrics

- Status: proposed
- Priority: must
- Stage: later
- Related: REQ-PERF-01, REQ-VER-02, INV-1

**Acceptance criteria**

- [ ] AC1: The verdict is computed by code from the tool's raw result files against the frozen thresholds.
- [ ] AC2: Runs are repeated a configurable number of times; when the spread between repetitions is above a configured limit the result is NEEDS_REVIEW.
- [ ] AC3: A run whose load generator did not reach the planned load, or was itself overloaded, is BLOCKED, never PASSED.

### REQ-PERF-04 · Baselines and trends

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-PERF-03, REQ-VER-11

**Acceptance criteria**

- [ ] AC1: Results are compared with a baseline from the previous release or the target branch on the same environment profile.
- [ ] AC2: A statistically significant regression beyond a configured tolerance is FAILED even when the absolute thresholds pass.
- [ ] AC3: Trends per scenario are shown across commits.

### REQ-PERF-05 · Safe load generation

- Status: proposed
- Priority: must
- Stage: later
- Related: REQ-ENV-01, REQ-NFR-05, REQ-SCALE-02

**Acceptance criteria**

- [ ] AC1: Load is generated only against environments the project explicitly marks as allowed for performance testing; production is denied unless an explicit, time-boxed authorisation exists.
- [ ] AC2: Every run has a maximum rate, a maximum duration and abort conditions (error rate or latency above a stop limit); hitting one stops the load at once.
- [ ] AC3: Distributed load generators run on QAJitsu workers within a cost budget.

### REQ-PERF-06 · Performance evidence

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-PERF-03, REQ-VER-16

**Acceptance criteria**

- [ ] AC1: Raw metrics, summaries, charts and the generated scripts are stored as evidence.
- [ ] AC2: The environment profile (instance sizes, replicas, data volume, versions) is recorded; results are compared only between runs with the same profile.
