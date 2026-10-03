# Project status

Roadmap stage 1 (Foundation) in progress: workspace, tooling, core types, guard, status model and CLI skeleton are in place; next is fetching a ticket and its code (REQ-CTX-01..04, REQ-WS-01).

| Area                                                                                   | State                                 |
| -------------------------------------------------------------------------------------- | ------------------------------------- |
| Monorepo, TypeScript, ESLint, Prettier, Vitest, Changesets, CI                         | done                                  |
| `@qajitsu/core`: errors, statuses, ids, interfaces, project config schema              | done (stage-1 subset)                 |
| `@qajitsu/guard`: policy, write bans, URL allowlist, journal                           | done (not yet wired to an agent loop) |
| `@qajitsu/steps` masking, `@qajitsu/verifier` status + gates, `@qajitsu/report` matrix | first slices                          |
| `@qajitsu/cli`: `--version`, `doctor`                                                  | done                                  |
| Adapters                                                                               | 11 stub packages, none implemented    |
| Requirements catalogue, roadmap, architecture docs                                     | done; `pnpm req:check` in CI          |
| Claude Code setup (rules, agents, skills, hooks)                                       | done; hooks tested                    |

Live numbers: `pnpm req:list -- --status in-progress` and the index in [requirements/README.md](requirements/README.md).

Next steps (stage 1):

1. REQ-WS-01: run workspace creation (`.qa-runs/<TICKET>/<RUN_ID>/`, subfolders, `run.json`).
2. REQ-CFG-03: `secrets-env` adapter and `secret://` resolution.
3. REQ-CTX-01: `ticket-jira` adapter with recorded fixtures; `qj fetch`.
4. REQ-CTX-02..04: `codehost-github`, `codehost-gitlab`, change discovery, repos at the change's commit.
5. REQ-OBS-01 / REQ-VER-04: journal written to `journal/events.jsonl`.
