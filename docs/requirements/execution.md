# Test execution (EXEC)

How approved cases become executable tests and how they run for API, web and mobile.

### REQ-EXEC-01 · Executable specs from the approved plan

- Status: implemented
- Priority: must
- Stage: 3
- Related: REQ-PLAN-06, REQ-CTX-06

The author agent writes test files for approved cases only. Exploring the app through MCP (Playwright MCP, appium-mcp) is allowed for finding selectors but never counts as test execution.

**Acceptance criteria**

- [x] AC1: One spec file per case under `specs/`, in TypeScript, using `@qajitsu/steps`.
- [x] AC2: MCP exploration is journaled and produces no results or evidence.
- [x] AC3: The author follows conventions of the project's tests repository when one is configured.

### REQ-EXEC-02 · Steps library: `step()` and `verify()`

- Status: implemented
- Priority: must
- Stage: 3
- Related: INV-4, REQ-PLAN-02, REQ-EVD-01

**Acceptance criteria**

- [x] AC1: `step(id, fn)` ties work to a plan step id and records evidence (screenshot for UI, request/response for API).
- [x] AC2: `verify(stepId, field, actual, expected)` records an assertion with expected and actual values.
- [x] AC3: Expected values are read from the approved plan via `plan.expect('<case>.<step>.<field>')`, not written by the agent.
- [x] AC4: Everything recorded passes through the masker.

### REQ-EXEC-03 · Static checks before execution

- Status: implemented
- Priority: must
- Stage: 3
- Related: REQ-EXEC-09, INV-4

**Acceptance criteria**

- [x] AC1: `tsc --noEmit` and lint on generated specs.
- [x] AC2: Plan coverage: every plan step has a `step()` and at least one `verify()`.
- [x] AC3: Assertion lock: `verify()` calls must use `plan.expect(...)`; literals and missing calls are rejected.
- [x] AC4: A spec failing checks returns to the author with the errors; after 2 failed attempts the case is BLOCKED.

### REQ-EXEC-04 · API testing

- Status: implemented
- Priority: must
- Stage: 3
- Related: REQ-EVD-01

**Acceptance criteria**

- [x] AC1: Runner on Playwright `APIRequestContext`.
- [x] AC2: Responses validated against the project's OpenAPI document when configured (`ajv`).
- [x] AC3: Authentication through account aliases and helpers.

### REQ-EXEC-05 · Web UI testing

- Status: implemented
- Priority: must
- Stage: 5
- Related: REQ-EVD-02, ADR-0004
- Note: AC1 reworded on 2026-10-04 (owner decision): Playwright Test was replaced by Playwright driven by the trusted parent, so an agent-written spec cannot judge its own result.

**Acceptance criteria**

- [x] AC1: Runner on Playwright (`playwright-core`) driven by the trusted parent process (ADR-0004): specs run in the sandbox and only send `ui.*` operations; Chromium by default, Firefox and WebKit configurable (`web.browser`).
- [x] AC2: `data-testid` and accessible-role selectors preferred; CSS-class selectors flagged in review.
- [x] AC3: Screenshot after each step, video and trace kept on failure.

### REQ-EXEC-06 · Mobile testing (Android and iOS)

- Status: implemented
- Priority: must
- Stage: 8
- Related: REQ-ENV-06, REQ-EVD-03

**Acceptance criteria**

- [x] AC1: Runner on WebdriverIO + Appium: UiAutomator2 (Android) and XCUITest (iOS).
- [x] AC2: Android first; iOS on macOS or a device farm.
- [x] AC3: Mobile cases run sequentially per device.

### REQ-EXEC-07 · Mixed cases

- Status: implemented
- Priority: should
- Stage: 5
- Related: REQ-EXEC-04, REQ-EXEC-05

**Acceptance criteria**

- [x] AC1: One case may combine UI actions and API checks (e.g. act in the browser, verify state through the API).

### REQ-EXEC-08 · Retries and FLAKY

- Status: implemented
- Priority: must
- Stage: 3
- Related: REQ-VER-01

**Acceptance criteria**

- [x] AC1: One retry on failure by default (configurable).
- [x] AC2: Success only on a retry yields FLAKY, never PASSED.
- [x] AC3: Every attempt and its evidence is kept.

### REQ-EXEC-09 · Healer limited to selectors and waits

- Status: implemented
- Priority: must
- Stage: 5
- Related: INV-4, REQ-EXEC-03

**Acceptance criteria**

- [x] AC1: After a failure, the healer may change selectors and waits only, at most 2 attempts per case.
- [x] AC2: An AST diff rejects any change to `verify()` calls, `plan.expect(...)` keys, or added `try/catch` around them.
- [x] AC3: Healed specs are re-run and their status follows the normal rules (a heal never turns FAILED into PASSED without a new passing run).

### REQ-EXEC-10 · Parallelism

- Status: implemented
- Priority: should
- Stage: 5
- Related: REQ-WS-04

**Acceptance criteria**

- [x] AC1: API and web cases run in parallel with a configurable worker count.
- [x] AC2: Mobile cases run sequentially per device; several devices may run in parallel.

### REQ-EXEC-11 · Human-in-the-loop steps

- Status: implemented
- Priority: should
- Stage: later
- Related: INV-1, INV-2, INV-8, REQ-VER-01, REQ-VER-04, REQ-EVD-01, ADR-0008

Some steps cannot be automated: an SMS or 2FA code, a physical device, a printout, a captcha. The plan marks such a
step as manual; the run pauses, a tester performs it and records the outcome, and the run continues. A manual tester
gets value from day one even when not everything can be automated. Needs an ADR: the step outcome comes from a
person, not from the runner.

**Acceptance criteria**

- [x] AC1: The planner may mark a step `manual: true` with instructions; only steps of the approved plan can be manual.
- [x] AC2: At a manual step the run pauses and asks the tester for the outcome (passed or failed), an optional note and an optional screenshot or file, in the terminal or through a pending-step file in CI.
- [x] AC3: The step result records `source: manual`, the person's identity and a timestamp; the attachment goes through masking and into the evidence manifest with its SHA-256.
- [x] AC4: Agents cannot answer a manual step; a tool call that tries is denied by the guard and journaled.
- [x] AC5: A manual step reported failed makes the case FAILED; no answer within the configured timeout makes it BLOCKED, never PASSED.
- [x] AC6: Matrix, report and Jira comment mark cases with manual steps and name who performed them.
- [x] AC7: Codes and secrets entered by the tester are never written to the journal, logs or evidence.

### REQ-EXEC-12 · Visual regression

- Status: accepted
- Priority: could
- Stage: later
- Related: INV-1, INV-4, REQ-EXEC-05, REQ-EVD-01

**Acceptance criteria**

- [ ] AC1: A web or mobile step can compare a screenshot against an approved baseline stored in the project (`.qa/baselines/`), with a configurable threshold and masked regions.
- [ ] AC2: A difference above the threshold makes the case FAILED with the baseline, the actual image and a diff image as evidence.
- [ ] AC3: A missing baseline never yields PASSED: the case is NEEDS_REVIEW and the new image is proposed as the baseline.
- [ ] AC4: Baselines are updated only by an explicit human command (`qj baseline accept`), never by an agent or the healer.

### REQ-EXEC-13 · Browser and viewport matrix

- Status: implemented
- Priority: could
- Stage: later
- Related: REQ-EXEC-05, REQ-EXEC-10

**Acceptance criteria**

- [x] AC1: Project config lists browsers (Chromium, Firefox, WebKit) and viewports; web cases run for each combination.
- [x] AC2: The matrix and report show a status per case and combination; a case is PASSED only if every combination passed.
- [x] AC3: An unavailable browser makes its combinations BLOCKED with the reason.

### REQ-EXEC-14 · Locale testing

- Status: accepted
- Priority: could
- Stage: later
- Related: INV-4, REQ-EXEC-05, REQ-PLAN-02

**Acceptance criteria**

- [ ] AC1: Project config lists locales and time zones; a case can run per locale.
- [ ] AC2: Expected number, date and currency formats come from the plan per locale (`plan.expect(...)`), never from the agent.
- [ ] AC3: The report shows a status per case and locale.

### REQ-EXEC-15 · Exploratory sessions

- Status: implemented
- Priority: could
- Stage: later
- Related: INV-1, INV-2, INV-7, INV-10, REQ-EXEC-01, REQ-VER-04, REQ-OBS-07, ADR-0004

An agent receives a session goal ("check the cart around the change"), explores the application and records the
session. It reports observations for a human to assess, never statuses.

**Acceptance criteria**

- [x] AC1: `qj explore <TICKET> --goal "<text>" --time-box <minutes>` runs a session on an allowlisted environment.
- [x] AC2: Every action is journaled and the session is recorded (video, screenshots, network); evidence is written by the trusted parent, not the agent.
- [x] AC3: Output is a list of observations with steps to reproduce and evidence references; the session produces no test statuses.
- [x] AC4: A person can turn an observation into a draft plan case; it runs only after plan approval.
- [x] AC5: The time box and step budget are enforced by code; when reached the session stops and keeps what it recorded.
- [x] AC6: Each session ends with a report for human review (`report.md`, `report.html`): goal, how it ended, the observations with the screenshots of their steps, the action timeline, and the video, trace, network and console files; observations are proposals for a person, never statuses.
