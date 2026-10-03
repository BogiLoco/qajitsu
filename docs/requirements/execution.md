# Test execution (EXEC)

How approved cases become executable tests and how they run for API, web and mobile.

### REQ-EXEC-01 · Executable specs from the approved plan

- Status: accepted
- Priority: must
- Stage: 3
- Related: REQ-PLAN-06, REQ-CTX-06

The author agent writes test files for approved cases only. Exploring the app through MCP (Playwright MCP, appium-mcp) is allowed for finding selectors but never counts as test execution.

**Acceptance criteria**

- [ ] AC1: One spec file per case under `specs/`, in TypeScript, using `@qajitsu/steps`.
- [ ] AC2: MCP exploration is journaled and produces no results or evidence.
- [ ] AC3: The author follows conventions of the project's tests repository when one is configured.

### REQ-EXEC-02 · Steps library: `step()` and `verify()`

- Status: accepted
- Priority: must
- Stage: 3
- Related: INV-4, REQ-PLAN-02, REQ-EVD-01

**Acceptance criteria**

- [ ] AC1: `step(id, fn)` ties work to a plan step id and records evidence (screenshot for UI, request/response for API).
- [ ] AC2: `verify(stepId, field, actual, expected)` records an assertion with expected and actual values.
- [ ] AC3: Expected values are read from the approved plan via `plan.expect('<case>.<step>.<field>')`, not written by the agent.
- [ ] AC4: Everything recorded passes through the masker.

### REQ-EXEC-03 · Static checks before execution

- Status: accepted
- Priority: must
- Stage: 3
- Related: REQ-EXEC-09, INV-4

**Acceptance criteria**

- [ ] AC1: `tsc --noEmit` and lint on generated specs.
- [ ] AC2: Plan coverage: every plan step has a `step()` and at least one `verify()`.
- [ ] AC3: Assertion lock: `verify()` calls must use `plan.expect(...)`; literals and missing calls are rejected.
- [ ] AC4: A spec failing checks returns to the author with the errors; after 2 failed attempts the case is BLOCKED.

### REQ-EXEC-04 · API testing

- Status: accepted
- Priority: must
- Stage: 3
- Related: REQ-EVD-01

**Acceptance criteria**

- [ ] AC1: Runner on Playwright `APIRequestContext`.
- [ ] AC2: Responses validated against the project's OpenAPI document when configured (`ajv`).
- [ ] AC3: Authentication through account aliases and helpers.

### REQ-EXEC-05 · Web UI testing

- Status: accepted
- Priority: must
- Stage: 5
- Related: REQ-EVD-02

**Acceptance criteria**

- [ ] AC1: Runner on Playwright Test (Chromium by default; Firefox and WebKit configurable).
- [ ] AC2: `data-testid` and accessible-role selectors preferred; CSS-class selectors flagged in review.
- [ ] AC3: Screenshot after each step, video and trace kept on failure.

### REQ-EXEC-06 · Mobile testing (Android and iOS)

- Status: accepted
- Priority: must
- Stage: 8
- Related: REQ-ENV-06, REQ-EVD-03

**Acceptance criteria**

- [ ] AC1: Runner on WebdriverIO + Appium: UiAutomator2 (Android) and XCUITest (iOS).
- [ ] AC2: Android first; iOS on macOS or a device farm.
- [ ] AC3: Mobile cases run sequentially per device.

### REQ-EXEC-07 · Mixed cases

- Status: accepted
- Priority: should
- Stage: 5
- Related: REQ-EXEC-04, REQ-EXEC-05

**Acceptance criteria**

- [ ] AC1: One case may combine UI actions and API checks (e.g. act in the browser, verify state through the API).

### REQ-EXEC-08 · Retries and FLAKY

- Status: accepted
- Priority: must
- Stage: 3
- Related: REQ-VER-01

**Acceptance criteria**

- [ ] AC1: One retry on failure by default (configurable).
- [ ] AC2: Success only on a retry yields FLAKY, never PASSED.
- [ ] AC3: Every attempt and its evidence is kept.

### REQ-EXEC-09 · Healer limited to selectors and waits

- Status: accepted
- Priority: must
- Stage: 5
- Related: INV-4, REQ-EXEC-03

**Acceptance criteria**

- [ ] AC1: After a failure, the healer may change selectors and waits only, at most 2 attempts per case.
- [ ] AC2: An AST diff rejects any change to `verify()` calls, `plan.expect(...)` keys, or added `try/catch` around them.
- [ ] AC3: Healed specs are re-run and their status follows the normal rules (a heal never turns FAILED into PASSED without a new passing run).

### REQ-EXEC-10 · Parallelism

- Status: accepted
- Priority: should
- Stage: 5
- Related: REQ-WS-04

**Acceptance criteria**

- [ ] AC1: API and web cases run in parallel with a configurable worker count.
- [ ] AC2: Mobile cases run sequentially per device; several devices may run in parallel.
