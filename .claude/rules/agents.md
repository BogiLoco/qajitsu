# When to delegate to project subagents

| Situation                                                                              | Subagent                                   |
| -------------------------------------------------------------------------------------- | ------------------------------------------ |
| Feature request or behaviour not covered by `docs/requirements/`                       | `/requirement` skill first, then `planner` |
| New feature spanning more than one package, or a roadmap stage                         | `planner`                                  |
| New interface, package boundary, cross-cutting decision, ADR                           | `architect`                                |
| Writing tests first, unsure how to mock the model or an API                            | `tdd-guide`                                |
| Change touches guard, verifier, steps, status or report code                           | `verification-auditor` (read-only)         |
| Anything touching secrets, shell exec, URLs, masking, dependencies                     | `security-reviewer` (read-only)            |
| Finished change before commit or PR                                                    | `code-reviewer` (read-only)                |
| `tsc`, ESLint, Vitest or pnpm failures you cannot fix in one try                       | `build-error-resolver`                     |
| demo-shop end-to-end runs, Playwright/Appium runner work, model benches                | `e2e-runner`                               |
| Public API, CLI flags, config schema or behaviour changed; acceptance criteria to tick | `doc-updater`                              |

Reviewers are read-only on purpose: they report, the main conversation fixes.
