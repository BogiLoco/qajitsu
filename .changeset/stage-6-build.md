---
"@qajitsu/core": minor
"@qajitsu/cli": minor
"@qajitsu/report": minor
"@qajitsu/adapter-env-compose": minor
---

Stage 6: local environments, configuration and cleanup. `qajitsu run --build` starts the application from the
run's worktree: Docker Compose with a generated overlay (project `qj-<ticket>-<suffix>`, dynamic localhost ports,
`qajitsu.*` labels on containers, networks and volumes), managed processes with logs, WireMock/Mockoon stubs listed
in the report, health checks and a seed hook with the run marker. Service variables are constants, templates
(`{{svc.db.url}}`, `{{port}}`) or secret references, with `--set` overrides for overridable ones; per-service `.env`
files are 0600 and deleted on every exit path. The configuration is validated before start (`qajitsu env check`,
exit code 3), the masked effective configuration is recorded in `run.json`, and a start failure makes every case
BLOCKED with the service logs as evidence. New commands: `env check`, `env render`, `runs`, `resume`, `clean`, `gc`;
cleanup policy and retention (`cleanup` section, `--keep`); run lock files and a locked run index.
