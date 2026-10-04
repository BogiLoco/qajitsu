# QAJitsu

Agentic QA framework: takes a Jira ticket, builds a test plan with an LLM, lets a human approve it,
executes API / web / mobile tests with deterministic runners, collects evidence and reports back to Jira.
Status: pre-alpha, roadmap stage 1 (`docs/STATUS.md`).

The single most important idea: **agents plan and write tests; deterministic code executes and judges.**
The non-negotiable invariants live in `.claude/rules/architecture-invariants.md` and load every session.

## Requirements are the source of truth

- What to build: `docs/requirements/` — numbered requirements `REQ-<AREA>-NN` with acceptance criteria `REQ-X-NN/ACk`, status and roadmap stage. Index: `docs/requirements/README.md`.
- When to build it: `docs/roadmap.md` (10 stages, "done when" per stage). How it fits: `docs/architecture/overview.md`. Why: `docs/adr/`, background `docs/plan.md` (Polish).
- Every change traces to requirement ids (test titles, commit footer `Refs: REQ-...`, PR). Rules: `.claude/rules/requirements.md`; editing requirements: `/requirement`.

## Stack

- TypeScript (strict), Node.js 22 LTS, ESM only, pnpm workspaces monorepo.
- Agents: own agent loop on Vercel AI SDK (multi-provider: Anthropic, OpenAI, Google, Ollama, OpenAI-compatible / LiteLLM). MCP tools via `@ai-sdk/mcp`.
- Validation: Zod at every boundary (config, plan, results, LLM output, HTTP responses).
- Runners: Playwright Test (API + web), WebdriverIO + Appium (mobile).
- Tests: Vitest (+ MSW for HTTP, `ai/test` mock models). Docs: TSDoc + TypeDoc, Markdown in `docs/`.
- Versioning: Changesets. Commits: Conventional Commits.

## Commands

| Command                             | What it does                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install`                      | Install workspace dependencies                                                                                                       |
| `pnpm verify`                       | typecheck + lint + format check + all tests with coverage + hook tests + requirements check. Must be green before any task is "done" |
| `pnpm test`                         | All Vitest suites except e2e: unit, contract, adversarial, golden, scripts (no network, no real LLM)                                 |
| `pnpm test:adversarial`             | Lying-agent scenarios against guard, gates and verifier                                                                              |
| `pnpm test:e2e`                     | Full flow on `examples/demo-shop` (from stage 3)                                                                                     |
| `pnpm test:hooks`                   | node:test suite of `.claude/hooks`                                                                                                   |
| `pnpm req:check` / `pnpm req:index` | Validate requirements / regenerate their index and roadmap lists                                                                     |
| `pnpm req:list -- --stage N`        | Requirements of a stage (also `--status in-progress`)                                                                                |
| `pnpm build` / `pnpm qajitsu <cmd>` | Build packages to `dist/` / run the built CLI                                                                                        |
| `pnpm format`                       | Prettier write                                                                                                                       |
| `pnpm bench -- --model <ref>`       | Benchmark a model on the demo-shop seeded bugs (real model calls; never in PR CI)                                                    |
| `pnpm docs`                         | API reference and guides with TypeDoc into `docs-site/` (every export needs TSDoc)                                                   |

## Repository map

- `packages/core` orchestrator state machine, run workspace, config loading, Zod schemas
- `packages/cli` the `qajitsu` / `qj` command
- `packages/agents` agent loop, role prompts (analyst, planner, author, healer, auditor)
- `packages/models` ModelProvider adapters and capability profiles
- `packages/guard` tool guard: write bans, URL allowlist, tool-call journal
- `packages/steps` `@qajitsu/steps`: `step()`, `verify()`, masking, evidence recording
- `packages/verifier` publish gates, assertion-lock AST diff, plan coverage, secret scan
- `packages/report` matrix (md/csv/xlsx), report.html, Jira ADF comment
- `packages/adapters/*` ticket, codehost, env, secrets, runner, evidence, publish adapters
- `tests/{contract,adversarial,e2e,golden}`, `fixtures/`, `examples/demo-shop` (fictional app with seeded bugs, `BUGS.md`)
- `docs/` requirements, roadmap, architecture, ADRs; `scripts/requirements.mjs` catalogue tooling
- `templates/qa/` starter `.qa/` config; `schemas/` published JSON Schemas; `bench/` model benchmark cases

## How to work here

0. Find the requirement ids for the task; if none fits, `/requirement add ...` first and confirm with the user.
1. Non-trivial feature: start with `/feature-plan` (uses the `planner` agent). Architecture questions go to the `architect` agent.
2. Implement with `/tdd`: failing test first, then code. No exceptions for `packages/guard`, `packages/verifier`, `packages/steps`.
3. Anything that decides, records or publishes a test status also needs `/adversarial-test`.
4. New integration (Jira DC, Bitbucket, Vault, a model provider...): `/new-adapter`.
5. Before saying "done" and before every commit: `/verify`. Then `/review-change` for anything touching more than one package.
6. Public API changed: TSDoc updated in the same change, plus a changeset (`pnpm changeset`).
7. Tick implemented and tested acceptance criteria, update status, `pnpm req:index`.

## Conventions that differ from defaults

- Language of code, comments, docs and commit messages: English.
- No `console.log` in `packages/**/src`; use the injected `pino` logger.
- No default exports. Named exports only, one public entry `src/index.ts` per package.
- Errors: typed error classes from `@qajitsu/core/errors`, never bare `throw new Error("...")` in library code.
- Never call a real LLM, Jira, GitHub or GitLab from unit, contract or adversarial tests. Use fixtures and mock models.
- Test data, tickets and screenshots in this repo are fictional (demo-shop). Never paste real company data.
