# Monitoring, logs and graphs (OBS)

Users can see what the tester did and when, and teams can monitor QAJitsu over time.

### REQ-OBS-01 · Structured event log per run

- Status: implemented
- Priority: must
- Stage: 1
- Related: REQ-VER-04, REQ-LLM-07

**Acceptance criteria**

- [x] AC1: `journal/events.jsonl` records stage start/end, every agent tool call (allowed or denied), every runner `step()`/`verify()`, human actions (approval, revisions, publish confirmation) and model usage.
- [x] AC2: Each event has ISO time, run id, ticket, stage, actor (agent role, runner or user) and masked details.

### REQ-OBS-02 · Viewing logs

- Status: implemented
- Priority: must
- Stage: 5
- Related: REQ-PUB-06

**Acceptance criteria**

- [x] AC1: `qajitsu logs <TICKET> [--run] [--follow] [--stage] [--agent] [--case]`.
- [x] AC2: `report.html` has a timeline tab; selecting an event shows the screenshot or request/response from that moment.

### REQ-OBS-03 · OpenTelemetry export

- Status: implemented
- Priority: should
- Stage: 9
- Related: REQ-OBS-04

**Acceptance criteria**

- [x] AC1: Run = trace, stage = span, tool call = child span; logs and metrics exported over OTLP.
- [x] AC2: Works with Grafana (Tempo, Loki, Prometheus), ELK and Datadog; optional Langfuse for prompts and model costs.

### REQ-OBS-04 · Metrics, dashboards and alerts

- Status: implemented
- Priority: could
- Stage: 9
- Related: REQ-OBS-03

**Acceptance criteria**

- [x] AC1: Metrics: runs, status distribution, BLOCKED reasons, duration and cost per ticket, plan acceptance without changes, false-FAILED rate.
- [x] AC2: Example alerts: stuck run, cost spike, BLOCKED series per environment, denied access outside the allowlist.
- [x] AC3: A Grafana dashboard (runs, statuses, tokens and cost, guard denials, logs, traces) is provisioned with a local stack (OpenTelemetry Collector, Tempo, Loki, Prometheus, Grafana) in `ops/grafana/`.

### REQ-OBS-05 · Tamper-evident audit log

- Status: implemented
- Priority: should
- Stage: 9
- Related: REQ-WS-03

**Acceptance criteria**

- [x] AC1: Each journal entry includes the hash of the previous entry (hash chain); verification command reports breaks.
- [x] AC2: Audit log retention is configured separately from workspace cleanup.

### REQ-OBS-06 · Transition graph per run

- Status: implemented
- Priority: should
- Stage: 5
- Related: REQ-OBS-02

Built by code from the journal, never drawn by an agent.

**Acceptance criteria**

- [x] AC1: Nodes are screens/pages (web: route pattern, mobile: screen/activity) and API endpoints (OpenAPI template); edges are tester actions.
- [x] AC2: Edges coloured by outcome (passed, failed); shown in `report.html`.
- [x] AC3: URL normalisation to route patterns (`/product/:id`) through router information or rules in `.qa/`.

### REQ-OBS-07 · Application map across runs

- Status: implemented
- Priority: could
- Stage: 9
- Note: accepted on 2026-10-04 by the owner.
- Related: REQ-OBS-06

**Acceptance criteria**

- [x] AC1: Per-run graphs aggregate into a project map showing tested and never-tested transitions.
- [x] AC2: The map is exported as JSON and rendered in a static page.

### REQ-OBS-08 · Map as planner input

- Status: implemented
- Priority: could
- Stage: later
- Related: REQ-OBS-07, REQ-PLAN-02

**Acceptance criteria**

- [x] AC1: The planner receives untested paths around changed screens and may propose regression cases for them.

### REQ-OBS-09 · Live progress of a run

- Status: accepted
- Priority: should
- Stage: later
- Related: INV-1, INV-6, INV-8, REQ-OBS-01, REQ-PRJ-10

While `qj run` works, a person sees which case and step is running and how far the run is, in the terminal and in a
local browser page, instead of waiting for the matrix at the end.

**Acceptance criteria**

- [ ] AC1: `qj run` prints when each case starts and ends with a counter (`TC-02 ▶ 2/5`), the step in progress and the elapsed time; outside a terminal (CI) the same as plain lines.
- [ ] AC2: `qj watch <TICKET>` serves a page on 127.0.0.1 that updates while the run runs: cases, current step, the latest screenshot of a web or mobile case, and a preliminary result per finished case.
- [ ] AC3: Progress is read from what the runner already wrote (journal, results, evidence); live results are labelled preliminary and the final statuses come only from the computed verdict after the run.
- [ ] AC4: A run that stopped or stalled is shown as stopped with its last event, never as passed; the page serves only masked progress and evidence, nothing from `env/` or `repos/`.
