# Getting started (contributors)

## Prerequisites

- Node.js 22 LTS (`.nvmrc`), pnpm 10 (`corepack enable` picks the version from `package.json`).
- Git. Docker only from stage 3 (e2e) and stage 6 (`--build`).
- Optional: VS Code with the recommended extensions (`.vscode/extensions.json`), Claude Code.

## First run

```bash
corepack enable
pnpm install
pnpm verify        # typecheck, lint, format, tests with coverage, hook tests, requirements check
pnpm build
pnpm qajitsu --version
pnpm qajitsu doctor   # exits 3 until a project has .qa/qa.project.yaml
```

## Commands

| Command                      | What it does                                                                |
| ---------------------------- | --------------------------------------------------------------------------- |
| `pnpm verify`                | Everything CI runs. Must be green before a commit.                          |
| `pnpm test`                  | All Vitest suites except e2e (unit, contract, adversarial, golden, scripts) |
| `pnpm test:adversarial`      | Only the lying-agent scenarios                                              |
| `pnpm test:e2e`              | demo-shop end to end (from stage 3)                                         |
| `pnpm test:hooks`            | Tests of the Claude Code hook scripts                                       |
| `pnpm req:check`             | Validate the requirements catalogue and generated lists                     |
| `pnpm req:index`             | Regenerate the requirements index and roadmap lists                         |
| `pnpm req:list -- --stage 1` | List requirements of a stage (also `--status in-progress`)                  |
| `pnpm changeset`             | Describe a user-visible change for the changelog                            |

## Making a change

1. Find or add the requirement in [`docs/requirements/`](../requirements/README.md). New idea → add it as `proposed`.
2. Set it to `in-progress`, branch `feat/<short-name>`.
3. Write a failing test titled with the id: `it("REQ-WS-01/AC2: ...")`. Then the code.
4. Tick the acceptance criteria you implemented and tested; `implemented` when all are ticked. `pnpm req:index`.
5. `pnpm verify`, commit with `Refs: REQ-WS-01` in the footer, open a PR using the template.

With Claude Code the same flow is `/requirement` → `/feature-plan` → `/tdd` → `/verify` → `/review-change` (see [`CLAUDE.md`](../../CLAUDE.md)).

## Layout

```text
packages/            core, guard, steps, verifier, report, models, agents, cli, adapters/*
tests/               adversarial, contract, golden, e2e (cross-package suites)
examples/demo-shop/  fictional app with seeded bugs (self-test, REQ-NFR-04)
templates/           starter .qa/ files for projects
bench/               model benchmark cases (stage 7)
fixtures/            recorded, scrubbed API responses for contract tests
schemas/             published JSON Schemas (plan, config, results)
docs/                requirements, roadmap, architecture, ADRs
scripts/             repo tooling (requirements checker)
.claude/             Claude Code rules, agents, skills, hooks
```

## Platforms (REQ-NFR-07)

Linux and macOS are supported and tested in CI on both. Windows is best effort: use WSL 2 (Ubuntu), where
QAJitsu behaves as on Linux. The sandboxed runner needs Node.js 22.12 or newer; `--build` needs Docker;
mobile needs the Android SDK (any of the three) or a Mac with Xcode or a device farm for iOS.

## Onboarding a project

```sh
cd your-repo
qajitsu init            # detects the git host, compose services, OpenAPI and test types; asks for Jira
qajitsu doctor --online # secrets, Docker, mobile tooling, Jira and code host access
```

`doctor` runs the tools the configuration names (`docker`, `mobile.appium.bin`, `xcrun`) with `--version`;
review `.qa/` of a repository you do not trust before running it.
