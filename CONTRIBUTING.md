# Contributing to QAJitsu

Thanks for helping. QAJitsu's value is trust in its results, so the bar for code that decides, records or publishes a
test status is high. Everything else should be easy to contribute.

## Setup

Node.js 22 LTS and pnpm 10 (`corepack enable`). Then `pnpm install && pnpm verify` (the first run downloads Chromium for the web runner tests; `pnpm demo` shows the whole flow). Details: [getting started](docs/guides/getting-started.md).

## Workflow

1. **Requirement first.** Find the requirement in [docs/requirements/](docs/requirements/README.md) or propose one
   (issue "Feature request", or add it with `Status: proposed` in your PR).
2. **Branch** `feat/<short-name>`, `fix/...`, `docs/...`, `chore/...`.
3. **Test first.** Name tests after the criterion they cover: `it("REQ-VER-03/AC1: denies agent writes to results/")`.
   Code in `packages/guard`, `packages/verifier` and `packages/steps` needs 95% coverage; anything that decides or
   publishes a status needs an adversarial test in `tests/adversarial`.
4. **Tick criteria** you implemented and tested, set the status, run `pnpm req:index`.
5. **Verify**: `pnpm verify` must be green. Never weaken a test or lower a threshold to get there.
6. **Commit** with [Conventional Commits](https://www.conventionalcommits.org/) and a package scope, and reference requirements in the footer:

   ```text
   feat(guard): deny writes through symlinks

   Refs: REQ-VER-03
   ```

7. **Changeset** for user-visible changes: `pnpm changeset`.
8. **PR** using the template. One logical change per PR.

## Rules that matter most

- The [architecture invariants](.claude/rules/architecture-invariants.md) are non-negotiable. If you need to break one,
  open an issue and propose an ADR first ([docs/adr/](docs/adr/)).
- No secrets, real company data or unscrubbed recordings anywhere in the repository. Fixtures are fictional or scrubbed.
- No real LLM, Jira, GitHub or GitLab calls in unit, contract or adversarial tests.
- Coding style: [.claude/rules/coding-style.md](.claude/rules/coding-style.md) (strict TypeScript, Zod at boundaries,
  named exports, typed errors, TSDoc on exports).

## Adding an integration

Each integration is a package in `packages/adapters/<kind>-<name>` implementing an interface from `@qajitsu/core`
and passing that interface's contract suite. See [packages/adapters/README.md](packages/adapters/README.md).

## Working with AI assistants

The repo includes a Claude Code setup: `CLAUDE.md`, rules, subagents, skills (`/requirement`, `/feature-plan`, `/tdd`,
`/verify`, `/review-change`, ...) and hooks that block dangerous commands and protected-file edits. You are responsible
for every line you submit, whoever wrote it.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
