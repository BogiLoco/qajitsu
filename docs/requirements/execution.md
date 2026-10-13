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

- Status: implemented
- Priority: could
- Stage: later
- Related: INV-1, INV-4, REQ-EXEC-05, REQ-EVD-01

**Acceptance criteria**

- [x] AC1: A web or mobile step can compare a screenshot against an approved baseline stored in the project (`.qa/baselines/`), with a configurable threshold and masked regions.
- [x] AC2: A difference above the threshold makes the case FAILED with the baseline, the actual image and a diff image as evidence.
- [x] AC3: A missing baseline never yields PASSED: the case is NEEDS_REVIEW and the new image is proposed as the baseline.
- [x] AC4: Baselines are updated only by an explicit human command (`qj baseline accept`), never by an agent or the healer.

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

- Status: implemented
- Priority: could
- Stage: later
- Related: INV-4, REQ-EXEC-05, REQ-PLAN-02

**Acceptance criteria**

- [x] AC1: Project config lists locales and time zones; a case can run per locale.
- [x] AC2: Expected number, date and currency formats come from the plan per locale (`plan.expect(...)`), never from the agent.
- [x] AC3: The report shows a status per case and locale.

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

### REQ-EXEC-16 · Run one case with a live view

- Status: implemented
- Priority: should
- Stage: later
- Related: INV-1, INV-3, INV-10, REQ-EXEC-05, REQ-EXEC-06, REQ-OBS-09

A tester runs a single approved web or mobile case and watches it happen: the browser or the emulator is visible and
the run can go step by step, to understand a failure or show a case to someone.

**Acceptance criteria**

- [x] AC1: `qj run <TICKET> --cases TC-02[,TC-03]` runs only the named cases of the approved plan; an id not in the plan is refused; cases not selected are not run and are reported as NOT_RUN ("not selected"), never PASSED.
- [x] AC2: `--headed` shows the browser of web cases (with `--slow-mo <ms>`) and the emulator window of mobile cases; without a display it stops with a clear error before anything runs.
- [x] AC3: `--step` pauses before every step with its action and expected result and continues on Enter; time spent paused does not count toward step timeouts.
- [x] AC4: Statuses are computed exactly as in a normal run; a run interrupted while paused leaves the case NOT_RUN or BLOCKED, never PASSED.

### REQ-EXEC-17 · Regression runs of promoted packs

- Status: implemented
- Priority: should
- Stage: later
- Related: INV-1, INV-3, INV-4, INV-6, REQ-PUB-08, REQ-VER-08

The packs `qj promote` put in the tests repository become a regression suite QAJitsu can run again on a new version,
without agents or models.

**Acceptance criteria**

- [x] AC1: `qj regression [--env <profile>] [--packs <TICKET>,...]` runs the promoted packs of the tests repository with the same sandboxed runners and no agent or model call.
- [x] AC2: Every spec and the expectations are checked against the hashes recorded in the pack's `expectations.yaml`; a mismatch makes that case BLOCKED with the reason, never PASSED.
- [x] AC3: Statuses are computed by the verifier; the report (matrix, report.html, junit.xml) covers the whole suite and lists as regressions the cases that passed when promoted and fail now.
- [x] AC4: The exit code follows `qj run`; the report can be published to a Jira ticket after preview.

### REQ-EXEC-18 · Compare the UI with the design in Figma

- Status: accepted
- Priority: could
- Stage: later
- Related: INV-1, INV-8, INV-10, REQ-EXEC-12, REQ-EVD-08
- Note: recorded on 2026-10-07 at the owner's request as a future requirement; not scheduled yet.

A step can be checked against its design in Figma: the frame exported from Figma becomes the reference picture, and
where layers are named like the app's test ids, their position, size, colour, font and text are compared with the
real elements. A design is not a pixel-exact picture of the running app (fonts, real data, anti-aliasing), so a
difference asks a person to look; it does not fail the case.

**Acceptance criteria**

- [ ] AC1: A plan step can expect `visual: { name, figma: "<file key>/<node id>" }`; the frame is exported from the Figma API (token as a `secret://` reference, host on the allowlist) and compared with the step's screenshot by the code of REQ-EXEC-12, with masks and the threshold.
- [ ] AC2: A difference above the threshold makes the case NEEDS_REVIEW (never FAILED, never PASSED) with the design, the screenshot, the diff and the changed regions marked (REQ-EVD-08) as evidence; the exported frame is kept in the evidence with its SHA-256 and the Figma version it came from.
- [ ] AC3: When a Figma layer is named like an element selector (e.g. `testid:pay`), its position, size, colour, font and text are compared with the element in the browser or on the device within configured tolerances; each difference is listed with expected (design) and actual (app) values and marked on the screenshot.
- [ ] AC4: Figma not reachable, a missing node or a missing token makes the design check BLOCKED with the reason; the rest of the step is checked as usual.

### REQ-EXEC-19 · Execution lanes and sequential runs

- Status: implemented
- Priority: should
- Stage: later
- Related: INV-1, REQ-EXEC-10, REQ-EXEC-13, REQ-EXEC-16, REQ-ENV-09

API, web and mobile cases of one run run at the same time in separate lanes, each with its own number of cases at
once; a run can also go one case at a time.

**Acceptance criteria**

- [x] AC1: API, web and mobile cases run in separate lanes at the same time; `execution.workers.api` and `execution.workers.web` set how many cases of each run at once (default `environments.workers`), and mobile cases start as soon as their devices are ready instead of after the other cases.
- [x] AC2: `qj run --sequential` (or `execution.sequential: true`) runs one case at a time in plan order across all lanes and devices; `--cases` runs only the named cases.
- [x] AC3: `execution.web_combinations` (default 1) runs that many browser and viewport combinations of `web.matrix` at the same time; each combination keeps its own results and evidence.
- [x] AC4: Order and concurrency never change how a status is computed: each case writes its own results file and evidence, and its journal events carry the case and the lane.
- [x] AC5: `--headed` and `--step` keep one case at a time.

### REQ-EXEC-20 · Several different mobile devices

- Status: implemented
- Priority: should
- Stage: later
- Related: REQ-EXEC-06, REQ-EXEC-10, REQ-ENV-06, REQ-GEN-06, REQ-EXEC-19

Mobile cases can run on several different devices at once: to finish sooner, or to check every case on each device.

**Acceptance criteria**

- [x] AC1: `mobile.android.emulators` lists emulator profiles (name, AVD, system image, hardware profile), each started as its own emulator with its own Appium session; `mobile.ios.farm.devices` lists device and OS version pairs for a device farm.
- [x] AC2: `mobile.distribute: split` divides the mobile cases among the devices; `matrix` runs every mobile case on every device, the first device being the primary run.
- [x] AC3: In matrix mode each device keeps its own results and evidence; a case is PASSED only when it passed on every device, and the report shows the status per device.
- [x] AC4: A device that cannot start is reported with the reason and the other devices go on: in matrix mode its results are BLOCKED, in split mode its cases run on the devices that started.
- [x] AC5: `qj setup` installs the system image and creates the AVD of every emulator profile, and its memory precheck counts every emulator.

### REQ-EXEC-21 · Selectors for any web or mobile application

- Status: implemented
- Priority: must
- Stage: later
- Related: REQ-EXEC-05, REQ-EXEC-06, REQ-EXEC-09, REQ-PLAN-09, INV-4

Tests must work on applications as they are: with any test id attribute, with Android resource ids only, or with no
test ids at all. Selector kinds cover what each platform offers, from the most stable to the last resort.

**Acceptance criteria**

- [x] AC1: The web test id attribute is configurable (`web.test_id_attribute`, default `data-testid`, e.g. `data-qa`, `data-test`, `data-cy`); `testid:` selectors, the element inventory and the prompts use it.
- [x] AC2: On Android `testid:<id>` finds the accessibility id (content-desc) or the resource id (`<package>:id/<id>` or `<id>`); on iOS the accessibility identifier.
- [x] AC3: Web selectors also include `placeholder:`, `alt:`, `title:` and `id:` (DOM id), and `role:<role>:<name>` and `label:` work without any test id; mobile selectors include `text:`, `label:`, `id:` (resource id) and `xpath:` as the last resort.
- [x] AC4: The element inventory also finds Android `@+id/...` in layouts and code, Flutter `Key('...')` and `Semantics(identifier:)`, SwiftUI `.accessibilityIdentifier(...)`, and the configured web attribute.
- [x] AC5: The prompts of the author and the healer list the selector kinds in order of stability and contain no element ids or pages of the demo application; a test checks that.
- [x] AC6: Without any test id in the code, the plan check does not judge element names (nothing to compare against) and the author relies on roles, labels, texts and the UI snapshot (REQ-EXEC-22); `css:` and `xpath:` selectors are flagged in review.
- [x] AC7: A screen that exposes no accessible elements (canvas, game, Flutter without semantics) makes the case BLOCKED with that reason, never PASSED.

### REQ-EXEC-22 · Snapshot of the running application for the author and the healer

- Status: implemented
- Priority: must
- Stage: later
- Related: REQ-EXEC-01, REQ-EXEC-09, REQ-EXEC-21, REQ-ENV-01, INV-2, INV-8, INV-10

The author sees what the application really shows instead of guessing selectors from code: code opens the running
application and records its accessible elements; the agent only reads that record.

**Acceptance criteria**

- [x] AC1: Before the author writes a UI case, the trusted parent opens the pages the case names (web, after logging in with the case's account alias) or the start screen of the app (mobile) on the run's environment and records the accessibility snapshot: role, name, label, text, test id, resource id and a ready selector for each element.
- [x] AC2: The snapshot is masked like evidence before an agent sees it, is limited in size, and is passed to the author and the healer as untrusted data; recording it is journaled and produces no results or evidence.
- [x] AC3: A selector the author writes that matches no element of the snapshot is reported back to the author with the closest elements before the spec runs.
- [x] AC4: When a step fails because an element is missing, the healer gets the snapshot of the current page or screen, on web and on mobile (healing extends to mobile cases).
- [x] AC5: Snapshots respect the environment allowlist; production is never opened for a snapshot.
- [x] AC6: When the snapshot cannot be taken (environment down, page not reachable), the author works without it and the run says so; the case's status still comes only from the runner.
- [x] AC7: Without any repository (only a test environment), the snapshot is the source of element names: the planner also gets a snapshot of the pages and screens it can reach from the environment's start page or the app's start screen, so plan expectations use names the application really shows.
- [x] AC8: A plan expectation naming an element that no snapshot contains is flagged in the review like an unknown selector (REQ-PLAN-09/AC8), whether or not the code is available.
- [x] AC9: `qj plan --build` starts the environment from the run's worktree and the devices of mobile cases (building the app when configured) only to record the pages and the app's first screen for the planner, then stops them; a start failure is reported and planning goes on without them.

### REQ-EXEC-23 · Mobile app without access to its code

- Status: implemented
- Priority: should
- Stage: later
- Related: REQ-EXEC-06, REQ-EXEC-22, REQ-ENV-06, INV-10

Mobile cases can run when the team has only a test build of the app, not its repository.

**Acceptance criteria**

- [x] AC1: `mobile.android.app` and `mobile.ios.app` also accept a file (`source: file`, a local `.apk`/`.ipa`/`.app`), a download (`source: url`, checked against the allowlist, with a SHA-256 to compare), an app already installed on the device or emulator (`source: installed`, by app id), and an app already uploaded to the device farm.
- [x] AC2: The run records the app's version and SHA-256 when known, and the report shows them in place of the commit.
- [x] AC3: An app that cannot be obtained or whose SHA-256 differs makes the mobile cases BLOCKED with the reason.
