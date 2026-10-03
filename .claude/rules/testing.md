# Testing

Full workflow: `tdd` skill. The rules:

- Test first. A feature or fix starts with a failing test that describes the behaviour.
- Test files live next to the code as `*.test.ts`, except cross-package suites in `tests/{contract,adversarial,e2e,golden}`.
- Unit, contract and adversarial tests are deterministic: no real network, no real LLM, no clock or random without injection. Use MSW for HTTP, `ai/test` mock models for agents, fake timers for time.
- Coverage thresholds (enforced in CI): 80% lines overall; 95% lines and branches for `packages/guard`, `packages/verifier`, `packages/steps`.
- A bug fix includes a regression test that fails without the fix.
- Changes to anything that decides, records or publishes a status need an adversarial test (`adversarial-test` skill).
- Golden files (`tests/golden`) change only deliberately: update them with `pnpm test -u` and explain why in the PR.
- Never weaken an assertion, skip a test or lower a threshold to make CI green. If a test is wrong, fix the test and say so explicitly.
- Flaky test found: quarantine with `test.fixme` plus an issue link in the same change, never a silent retry loop.
