---
"@qajitsu/cli": minor
"@qajitsu/report": minor
---

`qajitsu map` aggregates the transition graphs of every run into an application map (`map.json`, `map.html`) with
tested and never-tested screens and API operations (REQ-OBS-07). The Claude Code plugin in `plugin/` (marketplace in
`.claude-plugin/`) adds `/qa-plan`, `/qa-run` and `/qa-evidence` for chat-driven use, with approval always left to the
user (REQ-GEN-04). `ops/grafana` is a local OpenTelemetry Collector, Tempo, Loki, Prometheus and Grafana stack with the
QAJitsu overview dashboard (REQ-OBS-04/AC3).
