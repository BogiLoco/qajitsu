---
name: tdd
description: Test-first implementation workflow for QAJitsu. Use when implementing any feature or fix - write a failing Vitest test, make it pass, refactor, verify. Covers mocking models, HTTP APIs, shell and time.
argument-hint: "[what to implement]"
---

# /tdd: $ARGUMENTS

Implement the request above test-first. Delegate to the `tdd-guide` agent if the testing approach is unclear.

## 1. Define the behaviour

Find the requirement in `docs/requirements/` and the acceptance criteria this work covers. If none fits, stop and add one with `/requirement` first. Then write down, in one to three bullets, the observable behaviour to add or fix and the package's public function that exposes it. If the work spans packages, run `/feature-plan` first.

## 2. Red

- Create or extend `<file>.test.ts` next to the code (or `tests/<suite>/` for cross-package flows).
- Title tests with the criterion id: `it("REQ-WS-01/AC3: rejects a ticket key with path characters", ...)`. Group with `describe("<unit> (REQ-WS-01)")`.
- Write the smallest test for the first bullet. Run it: `pnpm vitest run <path>`.
- Confirm it fails for the expected reason. A test that passes before the change is a wrong test.

## 3. Green

Write the minimum code to pass. Run the test again.

## 4. Refactor

Clean up names, duplication and types with tests green. Add TSDoc to new exports now, not later.

## 5. Repeat for the next bullet

## 6. Finish

Tick the acceptance criteria that are now implemented and tested, set the requirement status (`in-progress`, or `implemented` when all are ticked), run `pnpm req:index`. Then run `/verify`. If the change touches guard, verifier, steps, status or report code, also run `/adversarial-test` for the new behaviour.

## Mocking cheat sheet

| Dependency                                     | Use                                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| LLM                                            | `MockLanguageModelV3` from `ai/test`, or `createScriptedModel([...])` from `@qajitsu/agents/testing` |
| Jira / GitHub / GitLab / LiteLLM / Ollama HTTP | MSW handlers with fixtures from `fixtures/<service>/`                                                |
| Shell, git, docker                             | Fake `Exec` port; assert argument arrays                                                             |
| File system                                    | Temp dir per test (`mkdtemp`), never the repo tree                                                   |
| Clock, RUN-ID, random                          | Injected fakes; `vi.useFakeTimers()` for timeouts                                                    |
| Playwright / Appium                            | Unit: fake runner result JSON. Real browsers only in `tests/e2e`                                     |

## Do not

- Write implementation before a failing test exists.
- Assert on LLM prose; assert on tool calls and validated structured output.
- Use `.skip`, `.only`, weakened matchers, or lowered thresholds to get green.
