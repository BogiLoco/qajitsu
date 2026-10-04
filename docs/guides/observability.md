# Observability: OpenTelemetry, metrics, alerts and the audit log (stage 9)

Everything below is computed from the run journal (`journal/events.jsonl`), which every component writes
through the masker. Telemetry never changes a result: a failing collector is reported and the run goes on.

## OpenTelemetry export (REQ-OBS-03)

```yaml
telemetry:
  otlp:
    endpoint: http://localhost:4318 # OTLP/HTTP; /v1/traces, /v1/logs, /v1/metrics are appended
    headers: { Authorization: secret://env/OTLP_AUTH } # values may be secret:// references
    service_name: qajitsu
    include_details: false # default: only ids, codes, counts and statuses leave the machine
```

What leaves the machine: span and log names, stages, actors, case ids, attempts, outcomes, statuses, tool
names, guard codes, model names, tokens and costs. Tool arguments and results, error messages, ticket and
plan content stay local unless `include_details: true`. Before sending, the payload is scanned for every
known secret value and nothing is sent on a hit. Remote collectors must use `https://`.

| Telemetry | What                                                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| trace     | one per run (`qajitsu <TICKET>`), stable ids derived from the run id                                                                                  |
| spans     | one per stage (`stage plan`, `stage run`, ...); children: tool calls (denied ones in error), model calls (`gen_ai.*` attributes, cost), case attempts |
| logs      | every journal event, WARN for denials, failures and mismatches; details already masked                                                                |
| metrics   | `qajitsu.model.tokens`, `qajitsu.model.cost`, `qajitsu.guard.denied`, `qajitsu.cases{status}`                                                         |

Every command (`approve`, `run`, `publish`) exports what it added to the journal; `qajitsu telemetry export
<TICKET>` sends anything left (backfill, a collector that was down).

### Grafana in one command (REQ-OBS-04/AC3)

`docker compose -f ops/grafana/docker-compose.yml up -d` starts a collector, Tempo, Loki, Prometheus and Grafana
with the **QAJitsu overview** dashboard (http://127.0.0.1:3000). Set `telemetry.otlp.endpoint:
http://127.0.0.1:4318` and every run appears there. Details: [ops/grafana/README.md](../../ops/grafana/README.md).

## Application map (REQ-OBS-07)

`qajitsu map [--openapi <file>]` aggregates the transition graphs of every run into `qa-map/map.json` and
`qa-map/map.html`: which screens and endpoints were tested, how each transition last ended, and which known
screens (`.qa/routes.yaml`) and API operations (OpenAPI) no test ever reached.

### Backends (REQ-OBS-03/AC2)

Point `endpoint` at an OpenTelemetry Collector and fan out from there:

```yaml
# otel-collector.yaml
receivers:
  otlp: { protocols: { http: { endpoint: 0.0.0.0:4318 } } }
exporters:
  otlp/tempo: { endpoint: tempo:4317, tls: { insecure: true } } # Grafana Tempo (traces)
  loki: { endpoint: http://loki:3100/loki/api/v1/push } # Grafana Loki (logs)
  prometheusremotewrite: { endpoint: http://prometheus:9090/api/v1/write } # Prometheus (metrics)
  elasticsearch: { endpoints: [https://elastic:9200] } # ELK
  datadog: { api: { key: ${env:DD_API_KEY} } } # Datadog
service:
  pipelines:
    traces: { receivers: [otlp], exporters: [otlp/tempo] }
    logs: { receivers: [otlp], exporters: [loki] }
    metrics: { receivers: [otlp], exporters: [prometheusremotewrite] }
```

Langfuse (prompts and model costs) accepts OTLP directly: `endpoint: https://cloud.langfuse.com/api/public/otel`
with `headers: { Authorization: secret://env/LANGFUSE_BASIC_AUTH }`. Model spans carry the OpenTelemetry GenAI
attributes (`gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`).

## Metrics and alerts (REQ-OBS-04)

`qajitsu metrics` aggregates every run in the workspace (Prometheus text, or `--format json`):

| Metric                                               | Meaning                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `qajitsu_runs{status}`                               | runs by lifecycle status                                       |
| `qajitsu_cases{status,environment}`                  | final case statuses per environment                            |
| `qajitsu_blocked{reason,environment}`                | BLOCKED cases by reason (env_start_failed, spec_rejected, ...) |
| `qajitsu_run_duration_seconds{ticket}`               | wall time of finished runs                                     |
| `qajitsu_run_running_seconds{ticket,run}`            | age of running runs (stuck runs)                               |
| `qajitsu_tokens{ticket}`, `qajitsu_cost_usd{ticket}` | model usage and estimated cost                                 |
| `qajitsu_plan_accepted_unchanged_ratio`              | approved runs whose first plan version was approved            |
| `qajitsu_false_failed_ratio`                         | clean benchmark runs with a FAILED case                        |
| `qajitsu_guard_denied{code}`                         | agent tool calls the guard denied                              |

Scrape it with the node_exporter textfile collector:
`qajitsu metrics --out /var/lib/node_exporter/textfile_collector/qajitsu.prom` (cron, or after each CI run).
Example alerts (stuck run, cost spike, BLOCKED series per environment, access outside the allowlist,
false-FAILED rate): [docs/ops/prometheus-alerts.yml](../ops/prometheus-alerts.yml).

## Tamper-evident audit log (REQ-OBS-05)

Each journal line carries `prev`, the SHA-256 of the line before it (64 zeros for the first). Every process
(fetch, plan, run, publish) continues the chain from the last line on disk.

- `qajitsu audit verify <TICKET> [--run <id> | --all]` or `--file <journal>` reports the first broken line;
  exit code 1 when a chain is broken.
- Publishing requires the `journal-intact` gate: the chain must be intact, the journal present, and not
  shorter than the anchor (line count and tail hash) each command records in `run.json`. Journals from
  before the chain existed pass as legacy.
- What it protects against: accidental edits, removed, reordered or inserted lines, a cut journal, and agents
  (which can write neither `journal/` nor `run.json`). It does not stop a person who can rewrite both
  `events.jsonl` and `run.json` consistently; that needs a signing key held outside the workspace.
- `qajitsu gc` copies the journal of every run it deletes to `<workspace root>/.audit/<TICKET>/<run>.events.jsonl`
  and keeps it for `audit.retention_days` (default 365), independently of `cleanup.keep_last`/`max_age_days`.

```yaml
audit:
  retention_days: 730
```
