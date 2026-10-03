# Claude Code setup for QAJitsu

Project-level configuration that loads automatically for anyone who opens this repository in Claude Code. Modelled on the layout of [everything-claude-code](https://github.com/WorldFlowAI/everything-claude-code), cut down and rewritten for this project.

```text
CLAUDE.md                     project memory: stack, commands, repo map, workflow (< 100 lines)
.mcp.json                     Playwright MCP for exploring demo-shop and building the web runner
.claude/
  settings.json               permissions + hook registration
  rules/                      always-on or path-scoped rules
    architecture-invariants.md  the 12 non-negotiables (always loaded)
    security.md, testing.md, git-workflow.md, agents.md, requirements.md   (always loaded)
    coding-style.md           loads for packages/**/*.ts and examples/**/*.ts
    trust-core.md             loads for guard, verifier, steps, status and report code
  agents/                     subagents
    planner, architect, tdd-guide, build-error-resolver, e2e-runner, doc-updater
    code-reviewer, security-reviewer, verification-auditor   (read-only, Bash restricted by hook)
  skills/                     slash commands and knowledge
    /requirement /tdd /verify /feature-plan /review-change /new-adapter /adversarial-test /demo-bug
    /docs-and-adr /model-evals /release
    background only: qajitsu-architecture, coding-standards, security-review
  hooks/                      Node scripts, zero dependencies
    guard-bash.mjs            PreToolUse Bash: blocks force push, push to main, --no-verify, npm/yarn, publish, curl|sh, reading .env
    protect-files.mjs         PreToolUse edits: blocks .env, lockfile, .qa-runs/, content with real credentials
    readonly-bash.mjs         reviewer subagents only: read-only command allowlist
    post-edit.mjs             PostToolUse: Prettier (when installed) + console/any/ts-ignore/.only checks
    stop-check-tests.mjs      Stop: library source changed without tests, or requirements catalogue invalid → continue once and fix
    session-start.mjs         SessionStart: branch, uncommitted files, docs/STATUS.md, requirements in progress
    __tests__/                node:test suite for all of the above
```

## Day-to-day flow

`/requirement` (find or add the REQ ids) → `/feature-plan <stage>` → `/tdd <behaviour>` (+ `/adversarial-test` for trust-core code) → `/verify` → `/review-change` → commit with `Refs: REQ-...`.

Agents get requirement context from three places: the always-loaded rule `rules/requirements.md`, the `qajitsu-architecture` skill (preloaded by planner and architect), and the SessionStart hook, which lists requirements in progress.

## Test the hooks

```bash
pnpm test:hooks   # same as: node --test ".claude/hooks/__tests__/*.test.mjs"
```

## Mapping from everything-claude-code

| Their component                                                                                                        | Here                                                                                                                    | Why                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| agents: planner, architect, tdd-guide, code-reviewer, security-reviewer, build-error-resolver, e2e-runner, doc-updater | kept, rewritten for QAJitsu                                                                                             | same roles, project-specific checklists                                                                                           |
| agent: refactor-cleaner                                                                                                | removed                                                                                                                 | covered by code-reviewer "Simplicity" and lint; revisit when the codebase grows                                                   |
| —                                                                                                                      | **verification-auditor** (new)                                                                                          | guards the core promise: fail stays fail                                                                                          |
| skills: coding-standards, tdd-workflow, security-review, verification-loop, eval-harness                               | kept as coding-standards, tdd, security-review, verify, model-evals                                                     | tailored to TS, Vitest, mock models, demo-shop bench                                                                              |
| skills: backend-patterns, frontend-patterns                                                                            | removed                                                                                                                 | no web backend or React app in this project                                                                                       |
| skills: continuous-learning, strategic-compact                                                                         | removed                                                                                                                 | Claude Code's auto memory and auto-compaction cover this                                                                          |
| —                                                                                                                      | requirement (new): add, change, deprecate, trace requirements                                                           | requirements catalogue in `docs/requirements/` is the source of truth                                                             |
| —                                                                                                                      | qajitsu-architecture, new-adapter, adversarial-test, demo-bug, docs-and-adr, feature-plan, review-change, release (new) | project workflows                                                                                                                 |
| commands/                                                                                                              | merged into skills                                                                                                      | Claude Code treats skills as slash commands; one mechanism instead of two                                                         |
| commands: build-fix, e2e, refactor-clean, learn, checkpoint, setup-pm                                                  | removed                                                                                                                 | agents trigger automatically by description; pnpm is fixed; git is the checkpoint                                                 |
| rules: security, coding-style, testing, git-workflow, agents                                                           | kept, tailored; coding-style is path-scoped                                                                             |                                                                                                                                   |
| rule: performance                                                                                                      | removed                                                                                                                 | model choice is a product feature here (models.roles), not a dev rule                                                             |
| —                                                                                                                      | architecture-invariants, trust-core, requirements (new)                                                                 |                                                                                                                                   |
| hooks: memory-persistence, strategic-compact, session lifecycle                                                        | replaced by guard, protect-files, post-edit, stop-check-tests, session-start                                            | enforcement instead of context juggling                                                                                           |
| contexts/, examples/                                                                                                   | removed                                                                                                                 | CLAUDE.md and skills cover them                                                                                                   |
| mcp-configs/                                                                                                           | `.mcp.json` with Playwright only                                                                                        | keep tool count low; Appium MCP added per session when working on mobile: `claude mcp add appium-mcp -- npx -y appium-mcp@latest` |
| .claude-plugin/, marketplace                                                                                           | not needed                                                                                                              | project config loads from the repo; can be packaged as a plugin later                                                             |

## Notes

- Personal overrides go in `CLAUDE.local.md` and `.claude/settings.local.json` (both gitignored).
- Hooks run with `node` from your PATH; they need no `pnpm install`.
- To allow a deliberate no-test change past the Stop hook: `QAJITSU_ALLOW_NO_TESTS=1`.
- `.mcp.json` uses `@playwright/mcp@latest` for convenience; pin a version once the runner stabilises.
