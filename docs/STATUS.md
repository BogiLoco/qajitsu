# Project status

Roadmap stages 1–3 work end to end on the demo-shop: `qj fetch` → `qj plan` (analyst + planner, verified with a local Ollama model) → `qj approve` (SHA-256 freeze) → `qj run --env local` (author agent, static checks, sandboxed API runner, evidence, statuses computed by code, publish gates, matrix/CSV/XLSX/HTML). The self-test proves every seeded API bug ends FAILED and PASSED without its flag. `qj publish` posts the gated results to Jira Cloud or Data Center after a preview (stage 4). Stage 5: web and mixed cases run in a browser driven by the trusted parent (ADR-0004), with healing, timeline, transition graph, `qj logs`, `qj evidence`, `qj pull`. The self-test covers all seven seeded API and UI bugs. Stage 6: `qj run --build` starts the application from the run's worktree with Docker Compose or managed processes (labels, dynamic ports, 0600 env files, stubs, health checks, seed hook with the run marker), validates the configuration first (`qj env check`), and cleans up per policy; `qj runs`, `resume`, `clean`, `gc` with run locks. Stage 7: an independent auditor (a different model by default) reviews every PASSED against plan, results, evidence and screenshots and can only downgrade to NEEDS_REVIEW; an optional canary re-runs one PASSED case with an inverted expectation; every planned expectation needs its own `verify()`; `qj bench` measures detection, false FAILED, BLOCKED, plan acceptance, time and cost per model. Stage 8: mobile cases run on Android through Appium (UiAutomator2) with the device driven by the trusted parent; QAJitsu builds or downloads the app for the change SHA (GitHub Actions, GitLab CI, worktree build), starts and stops the emulator and Appium, records the screen, logcat and page source; iOS runs on a device farm or is BLOCKED with the reason. The self-test catches BUG-08 on a real emulator. Stage 9: `qj init` onboards other projects (git host, compose services, OpenAPI, test types), `qj doctor --online` checks secrets, Docker, mobile tooling, Jira and code hosts; runs export OpenTelemetry traces, logs and metrics; `qj metrics` feeds Prometheus with example alerts; the journal is a hash chain (`qj audit verify`, `journal-intact` gate, separate audit retention); `pnpm docs` builds the TypeDoc site; CI runs on Linux and macOS. Next: stage 10 (CI/CD integrations).

| Area                                                                                   | State                                                                              |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Monorepo, TypeScript, ESLint, Prettier, Vitest, Changesets, CI                         | done                                                                               |
| `@qajitsu/core`: errors, statuses, ids, interfaces, project config schema              | done (stage-1 subset)                                                              |
| `@qajitsu/guard`: policy, write bans, URL allowlist, journal                           | done (not yet wired to an agent loop)                                              |
| `@qajitsu/steps` masking, `@qajitsu/verifier` status + gates, `@qajitsu/report` matrix | first slices                                                                       |
| `@qajitsu/cli`: `--version`, `doctor`, `fetch`                                         | done                                                                               |
| Adapters                                                                               | ticket-jira, codehost-github/gitlab/local, secrets-env implemented; others planned |
| Run workspace, event log, change discovery, git mirrors/worktrees (`@qajitsu/core`)    | done                                                                               |
| Requirements catalogue, roadmap, architecture docs                                     | done; `pnpm req:check` in CI                                                       |
| Claude Code setup (rules, agents, skills, hooks)                                       | done; hooks tested                                                                 |

Live numbers: `pnpm req:list -- --status in-progress` and the index in [requirements/README.md](requirements/README.md).

Next steps (stage 10): CI/CD integrations (GitHub Actions, GitLab CI, Jenkins), exit codes and pipeline reports.

Open from stage 9: REQ-OBS-07 (application map) and REQ-GEN-04 (Claude Code plugin) are `proposed` and need a decision; OTLP backends were verified with a test collector, not with live Grafana, ELK or Datadog instances.

Open from stage 8: iOS was verified with capabilities and the unavailable-platform path only; a real device farm or XCUITest run needs an account or Xcode.

Open from stage 5: REQ-EXEC-05/AC1 names Playwright Test; ADR-0004 uses Playwright driven by the parent instead (needs a requirement update), REQ-EXEC-10/AC2 (mobile, stage 8).
Open from stage 4: REQ-PUB-02/AC2 (individual media attachments, needs web evidence), REQ-PUB-02/AC3 (object storage for oversized files).
Open from stage 3: REQ-CTX-06 (tests repository awareness), REQ-EXEC-04/AC2 (OpenAPI validation), REQ-EXEC-01/AC2-3.
Open from stage 2: REQ-LLM-01/AC4 needs one run against a real cloud provider.
