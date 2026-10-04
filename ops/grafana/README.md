# QAJitsu dashboards in Grafana

A ready local stack: OpenTelemetry Collector → Tempo (traces), Loki (logs), Prometheus (metrics) → Grafana with
the **QAJitsu overview** dashboard (cases by status, FAILED/BLOCKED per ticket, tokens and cost, guard
denials, runs as traces, warnings from the journal).

```sh
docker compose -f ops/grafana/docker-compose.yml up -d
```

Point QAJitsu at the collector in `.qa/qa.project.yaml`:

```yaml
telemetry:
  otlp: { endpoint: http://127.0.0.1:4318 }
```

Run anything (`qj plan`, `qj run`, ...) and open http://127.0.0.1:3000 → Dashboards → QAJitsu → QAJitsu overview.

For an existing Grafana, import `dashboards/qajitsu-overview.json` and point the datasources with uids
`prometheus`, `loki` and `tempo` at your backends; `otel-collector.yaml` shows the collector pipelines.
