# QAJitsu

**Agentic QA that cannot lie.** Give QAJitsu a Jira ticket. It reads the ticket and the code that changed (GitHub or GitLab),
proposes a test plan for you to approve, runs API, web and mobile tests with deterministic runners, collects evidence
(request/response, screenshots, videos) and posts the test matrix back to Jira.

> Status: **pre-alpha**, roadmap stage 1 of 10. See [docs/STATUS.md](docs/STATUS.md) and the [roadmap](docs/roadmap.md).

```text
qj test SHOP-482 --env staging

 1. context    ticket, linked PRs/MRs, diffs, repos at the change's commit
 2. analysis   api / web / mobile, risks                    (agent)
 3. plan       plan.v1.yaml with sources for every case     (agent)
 4. review     you approve or ask for changes, any number of rounds
 5. freeze     approved plan hashed; nothing else will run
 6. env        given (--env) or built from the repos (--build)
 7. tests      generated from the plan; assertions locked
 8. run        Playwright / Appium decide the status, evidence recorded
 9. verify     gates + auditor (can only downgrade)
10. publish    matrix + evidence to Jira after your preview, then cleanup
```

## Why another tool

LLM agents are good at reading a ticket and a diff and deciding what to test. They are bad at being the judge of their
own work. QAJitsu splits the two: **agents plan and write tests; code executes and judges.** A FAILED test stays FAILED,
missing evidence is BLOCKED, never PASSED, and an independent auditor can only downgrade results. Twelve
[architecture invariants](.claude/rules/architecture-invariants.md) are enforced by code and by
[adversarial tests](tests/adversarial/) that simulate a lying agent.

## Features (planned)

- Jira Cloud and Data Center; GitHub and GitLab (including self-hosted); code always fetched at the change's version
- Human-approved, versioned test plans; approval also inside CI (GitHub Actions, GitLab CI)
- API, web and mobile (Android, iOS) testing; mixed API + UI cases
- Existing environments or local builds from the repositories with Docker Compose
- Evidence: request/response pairs, screenshots per step, failure videos you can open locally, traces
- Variables and secrets with `secret://` references; secrets never reach the model, logs or Jira
- One folder per ticket and run with a unique marker; cleanup and retention policies
- Any model: Anthropic, OpenAI, Google, any OpenAI-compatible gateway (LiteLLM, vLLM), local models via Ollama; per-role assignment
- Run journal, log viewer, transition graph of what the tester did, OpenTelemetry export
- Generic: a project plugs in through a `.qa/` folder, integrations are adapters

Every feature is a numbered requirement with acceptance criteria in [docs/requirements/](docs/requirements/README.md).

## Repository

```text
packages/core        interfaces, schemas, config, statuses, errors (orchestrator later)
packages/guard       tool guard: write bans, URL allowlist, journal
packages/steps       step() / verify() for generated tests, masking, evidence
packages/verifier    status computation, publish gates
packages/report      test matrix, report.html, Jira comment
packages/models      model references and providers
packages/agents      agent roles and loop
packages/cli         qajitsu / qj
packages/adapters/*  Jira, GitHub, GitLab, env, secrets, runners, evidence, publishing
tests/               adversarial, contract, golden, e2e
examples/demo-shop   fictional app with seeded bugs for self-testing
docs/                requirements, roadmap, architecture, ADRs
```

## Development

```bash
corepack enable
pnpm install
pnpm verify      # typecheck, lint, format, tests + coverage, hook tests, requirements check
pnpm build
pnpm qajitsu --help
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/guides/getting-started.md](docs/guides/getting-started.md).
The repository ships a Claude Code setup (`CLAUDE.md`, `.claude/`) with project rules, subagents, skills and hooks.

## License

[Apache-2.0](LICENSE).
