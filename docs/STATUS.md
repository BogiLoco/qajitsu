# Project status

Roadmap stages 1–3 work end to end on the demo-shop: `qj fetch` → `qj plan` (analyst + planner, verified with a local Ollama model) → `qj approve` (SHA-256 freeze) → `qj run --env local` (author agent, static checks, sandboxed API runner, evidence, statuses computed by code, publish gates, matrix/CSV/XLSX/HTML). The self-test proves every seeded API bug ends FAILED and PASSED without its flag. `qj publish` posts the gated results to Jira Cloud or Data Center after a preview (stage 4). Next: stage 5 (web UI tests).

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

Next steps (stage 5):

1. demo-shop web UI with seeded UI bugs (BUG-05..07).
2. `runner-web` on Playwright: screenshots, video, trace; healer limited to selectors and waits.
3. Mixed API + UI cases, parallelism, media policy, `qj logs`, transition graph.

Open from stage 4: REQ-PUB-02/AC2 (individual media attachments, needs web evidence), REQ-PUB-02/AC3 (object storage for oversized files).
Open from stage 3: REQ-CTX-06 (tests repository awareness), REQ-EXEC-04/AC2 (OpenAPI validation), REQ-EXEC-01/AC2-3.
Open from stage 2: REQ-LLM-01/AC4 needs one run against a real cloud provider.
