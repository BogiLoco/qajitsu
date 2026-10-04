---
"@qajitsu/core": minor
"@qajitsu/cli": minor
"@qajitsu/adapter-ticket-jira": minor
"@qajitsu/adapter-codehost-github": minor
"@qajitsu/adapter-codehost-gitlab": minor
"@qajitsu/adapter-codehost-local": minor
---

Stage 9: generalization and operations. `qajitsu init` creates `.qa/` for any repository (git host from the remote,
compose services and ports, OpenAPI document, web/mobile test types) and validates it; `qajitsu doctor` checks secrets
by reference, Docker, Android SDK and Appium, iOS availability and, with `--online`, Jira and code host access
(`check()` on ticket sources and code hosts). Runs export OpenTelemetry traces (run = trace, stage = span, tool/model
calls and case attempts = child spans), logs and metrics over OTLP/HTTP (`telemetry` section, `qajitsu telemetry
export`). `qajitsu metrics` aggregates runs for Prometheus with example alert rules. The run journal is a SHA-256 hash
chain (`qajitsu audit verify`, `journal-intact` publish gate) and `gc` archives journals under `audit.retention_days`.
`pnpm docs` builds the TypeDoc site; CI runs on Linux and macOS.
