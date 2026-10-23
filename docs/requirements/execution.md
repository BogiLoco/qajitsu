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
- [x] AC5: A case whose plan runs it as a test account (`data.user`) has a spec that logs in as that account (`api.as(...)` or `ui.as(...)`) and, for api cases, makes its calls with the client `api.as(...)` returns (a dropped client or a call on the anonymous `api` outside a step that expects the 401 is refused); a spec that does not is refused like a missing `verify()`, so a test that forgot to log in ends BLOCKED, not FAILED as if the product were broken.

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
- [x] AC7: `--headed` shows the browser while the agent explores and `--slow-mo <ms>` slows every action down, checked like `qj run` (a display is needed); both are journaled with the session.
- [x] AC8: Act before summarising, for every explorer (browser, command line and any later kind): code rejects the final summary while the session has no recorded action and asks the agent to act, with its tools still available; a session whose agent never acts ends with `error` and an empty summary, never with a summary of testing that did not happen. Looking at the page is not an action.
- [x] AC9: Actions the agent asks for at once (several tool calls in one turn) are performed one at a time, in the order asked, for every explorer: each gets its own id, its own evidence and its own place in the live view, and none of them is lost.
- [x] AC10: The terminal of a browser session shows each action (what, on what, ok or the error), each rejected answer of the explorer and each observation as it happens, masked and stripped of control characters, as command-line sessions do (REQ-EXEC-24/AC9).

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

### REQ-EXEC-24 · Exploratory sessions of command-line tools

- Status: implemented
- Priority: should
- Stage: later
- Related: REQ-EXEC-15, REQ-GEN-05, REQ-GEN-03, REQ-OBS-01, INV-1, INV-2, INV-8, INV-10, ADR-0004

Exploratory sessions (REQ-EXEC-15) also for any command-line tool, QAJitsu's own `qj` first: an agent gets a goal such
as "try qj env up and qj explore on the same run", runs commands like a tester in a terminal, and records what looks
wrong. The trusted parent runs every command; the agent only asks for them and proposes observations.

**Acceptance criteria**

- [x] AC1: `qj explore <TICKET> --cli <tool> --goal "<text>"` starts a session in a throwaway sandbox folder (a copy of a fixture project, e.g. the demo shop) with the same time box and step budget as browser sessions.
- [x] AC2: The agent's tools run only the named tool, with an argument array and never a shell, in the sandbox folder, with a scrubbed environment (no secrets of the person, fictional ones from the fixture), a timeout per command, and the environment allowlist for any network the tool uses.
- [x] AC3: The agent can answer a command's prompts, run a command in the background, send it Ctrl+C, read files inside the sandbox and list processes, ports and containers the tool left behind; every action, its exit code, output, and changed files are recorded as evidence with SHA-256 by the trusted parent.
- [x] AC4: Observations (possible bug, usability, question, risk) cite the actions that reproduce them; code drops an observation whose steps are not actions of the session; the session produces no test statuses.
- [x] AC5: The report (`report.md`, `report.html`) lists the goal, every command with its output and exit code, the observations with their steps, and what was left running at the end; everything the session started is stopped and removed when it ends, also on a time-out.
- [x] AC6: `qj explore promote` turns a CLI observation into a draft case for a later CLI runner, or into a regression test proposal for the tool's own test suite; nothing runs without approval.
- [x] AC7: Any command-line tool can be explored, not only `qj`: `explore.cli.<name>` in `.qa/qa.project.yaml` names its program, the fixture folder copied into every sandbox, setup commands (argument arrays), environment variables and secrets by `secret://` reference, the hosts it may reach and the timeout per command; a tool without such an entry is refused.
- [x] AC8: The act-before-summarising rule of REQ-EXEC-15/AC8 applies: a summary before any command (`cli_run` or `cli_start`) is rejected and the agent is asked to run the commands of the goal; one that never does ends the session with `error`.
- [x] AC9: Live view of every explored tool: by default the terminal of `qj explore --cli` prints one line per action as it ends (the command, its exit code or state, the duration), each rejected answer of the explorer and each observation; `--headed` also shows every command as `$ <tool> <args>` with its output as it arrives, typed answers, signals, and the output of background commands prefixed with their id. Everything shown is masked like the evidence and changes no result.
- [x] AC10: `--slow-mo <ms>` waits that long before every command, typed line and signal, to follow the session; it is journaled with the session.
- [x] AC11: The session's terminal is recorded with its timings as `recordings/terminal.cast` (asciicast v2, replayable with `asciinema play`) and as a plain transcript `recordings/terminal.txt`, both in the evidence manifest with SHA-256; the report shows the transcript and how to replay the recording.

### REQ-EXEC-25 · Grounded reports of exploratory sessions

- Status: implemented
- Priority: should
- Stage: later
- Related: REQ-EXEC-15, REQ-EXEC-24, INV-1, INV-6

An explorer's final answer is a claim, not a fact. Every sentence in it must point at actions the trusted parent
recorded, and every item of the goal is either done with its actions or listed as not done with the reason, so a
session can never describe testing that did not happen or silently skip part of its goal.

**Acceptance criteria**

- [x] AC1: `--check "<item>"` (repeatable) gives the session an explicit checklist next to the goal; without it the explorer writes the checklist from the goal itself and the report marks it as written by the explorer, for a person to compare with the goal.
- [x] AC2: The explorer's answer lists every checklist item, in order, either with the actions that did it or with `not_done` and a reason, plus findings that each cite actions; code rejects an answer that drops, adds or reorders an item of `--check`, an item with neither actions nor a reason, a finding without actions, and any action id that is not an action of the session.
- [x] AC3: While the step budget is not used up, the first answer that leaves items not done is rejected and the explorer is told to do them now; a second answer may keep them not done with the reason, which the report shows.
- [x] AC4: In command-line sessions a flag such as `--qa-dir` named in an item or a finding must be in the arguments of the actions it cites, and a flag named in the free comment must be in some action of the session; otherwise the answer is rejected and the explorer is told which flag it never ran.
- [x] AC5: The report shows the checklist (item, who wrote it, the actions that did it or "not done" with the reason), the findings with links to their actions, and the explorer's comment last; a session that ends by the time box, the step budget or an error before an accepted answer lists every `--check` item as not reached with that reason, never as done.
- [x] AC6: The terminal output after a session says how many checklist items were done and names those not done.
- [x] AC7: In command-line sessions an item or finding that names a subcommand after the tool's name ("qj doctor") must cite an action that ran that subcommand; citing an action that ran something else is rejected.
- [x] AC8: An item claimed not done although an action of the session ran everything it names (its subcommand and flags) is rejected: a command that ran is done whatever its exit code or error, and that error is the result to report.
- [x] AC9: Findings and the explorer's comment that code cannot confirm are sent back once; if the explorer insists, they are dropped from the session and journaled (`explore.claim_dropped`) while the checklist and the confirmed findings are kept. Text the explorer quotes ('…' or "…") cites what a tool printed and is not checked as a command it ran.
- [x] AC10: An explorer that keeps claiming what code refuses does not lose its session: its last answer is corrected by code, never in its favour. An item whose claim is refused becomes not done with the refusal as the reason; an item an action did run (its subcommand and flags) gets that action; an item it did not report is not done. Each change is marked in the session and the report ("corrected by code") and journaled (`explore.claim_corrected`); a model cannot set that mark itself.

### REQ-EXEC-26 · Poor network conditions

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-ENV-03

**Acceptance criteria**

- [ ] AC1: Cases can request latency, bandwidth limits, packet loss or dropped connections between the client and a service (Toxiproxy or browser throttling).
- [ ] AC2: Conditions apply only to the run's own environment, never to shared environments.

### REQ-EXEC-27 · Document verification

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-EXEC-02

**Acceptance criteria**

- [ ] AC1: Generated PDF, CSV and XLSX files can be checked for text, fields and totals by deterministic helpers.
- [ ] AC2: The checked file is stored as evidence.

### REQ-EXEC-28 · Audio, voice and IVR

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-EXEC-02

**Acceptance criteria**

- [ ] AC1: Audio is captured and transcribed (ffmpeg plus a speech-to-text model such as Whisper).
- [ ] AC2: Assertions compare the transcript with expected phrases using a deterministic similarity threshold.
- [ ] AC3: The recording and the transcript are stored as evidence.

### REQ-EXEC-29 · Testing AI features

- Status: proposed
- Priority: should
- Stage: 9
- Related: REQ-EXEC-02, REQ-EXEC-30, INV-1

Chatbots, assistants, RAG search and other features built on models answer differently between runs, so their verdict is statistical and computed by code. Deterministic checks come first; a judge may only add doubt (REQ-EXEC-30); uncertainty is never PASSED.

**Acceptance criteria**

- [ ] AC1: Cases for AI features use deterministic checks: required and forbidden content, schema, length, latency and reference sets.
- [ ] AC2: Results are repeated a configurable number of times and reported as a pass rate against a threshold.
- [ ] AC3: No model sets or upgrades a status; the judge of REQ-EXEC-30 can only move PASSED to NEEDS_REVIEW.
- [ ] AC4: The verdict is computed from the pass rate with a confidence interval: PASSED only if the lower bound is at or above the threshold, FAILED if the upper bound is below it, otherwise NEEDS_REVIEW, with the number of repetitions shown.
- [ ] AC5: Conversation cases support multi-turn scripts with checks per turn and a fixed seed or temperature where the system under test allows it; the settings used are recorded.
- [ ] AC6: The model, version and prompt version of the system under test are recorded when the application exposes them.

### REQ-EXEC-30 · LLM judge that can only downgrade

- Status: proposed
- Priority: should
- Stage: 9
- Related: REQ-EXEC-29, REQ-VER-06, REQ-VER-16, REQ-PLAN-06, INV-1, INV-5

For qualities code cannot check (helpfulness, policy compliance, groundedness, tone) a judge adds evidence-backed doubt; like the auditor it can only move PASSED to NEEDS_REVIEW.

**Acceptance criteria**

- [ ] AC1: The rubric (criteria, scale, pass mark, examples) is part of the plan and frozen with it; the judge cannot use criteria that are not in the frozen plan.
- [ ] AC2: The judge runs only after the case's deterministic checks passed; a case that failed them stays FAILED without judging.
- [ ] AC3: A negative judgement moves a PASSED case to NEEDS_REVIEW; the judge never sets FAILED or PASSED.
- [ ] AC4: The judge returns structured output per criterion with quoted spans of the answer as evidence; code checks that every quoted span exists in the answer, and a judgement with a missing or invented quote is discarded and the case becomes NEEDS_REVIEW.
- [ ] AC5: Several judges from different model families can be configured with an agreement rule (for example 2 of 3); disagreement gives NEEDS_REVIEW.
- [ ] AC6: A judge uses another provider or model family than the system under test and than the planner; it gets the answer, the rubric and the reference material, and the ticket text only as untrusted data.
- [ ] AC7: Judge model, version, temperature, prompt and response are recorded in the audit trail; `qj verify-report` can check that the recorded judgement matches the recorded inputs.
- [ ] AC8: An unavailable, timed-out or schema-invalid judge gives NEEDS_REVIEW, never PASSED.
- [ ] AC9: The report shows the judge result in its own column, marked as model-based, next to the code verdict.

### REQ-EXEC-31 · Judge calibration and drift control

- Status: proposed
- Priority: should
- Stage: 9
- Related: REQ-EXEC-30, REQ-VER-09, REQ-LLM-06

**Acceptance criteria**

- [ ] AC1: Each rubric has a calibration set of answers labelled by people; a judge is enabled for a rubric only if its agreement with the labels reaches a configured threshold (for example agreement rate or Cohen's kappa).
- [ ] AC2: Every judging batch contains hidden canary answers with known labels; a judge that grades a canary wrongly voids the batch and the affected cases become NEEDS_REVIEW.
- [ ] AC3: Calibration runs again on a schedule and whenever the judge model or the rubric changes; the results are stored and shown.
- [ ] AC4: Cases the judge downgraded can be reviewed by a person; reviewed outcomes join the calibration set after approval.

### REQ-EXEC-32 · Evaluation of retrieval-augmented answers

- Status: proposed
- Priority: could
- Stage: 9
- Related: REQ-EXEC-29, REQ-EXEC-30

**Acceptance criteria**

- [ ] AC1: Deterministic checks: the expected source documents were retrieved, cited sources exist, and quoted text appears in those sources.
- [ ] AC2: Groundedness (claims supported by the retrieved text) is checked by the judge with quoted evidence (REQ-EXEC-30/AC4).
- [ ] AC3: Retrieved documents and citations are stored as evidence.

### REQ-EXEC-33 · Behaviour regression after model or prompt changes

- Status: proposed
- Priority: should
- Stage: 9
- Related: REQ-EXEC-29, REQ-VER-11

**Acceptance criteria**

- [ ] AC1: A frozen question set runs against the version before and after a change of model, prompt or retrieval configuration.
- [ ] AC2: Pass rates are compared per case with confidence intervals; a statistically significant drop is FAILED, an inconclusive change is NEEDS_REVIEW.
- [ ] AC3: The report shows the answers before and after for changed cases.

### REQ-EXEC-34 · LLM evaluation tools as runners

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-EXEC-29, REQ-EXEC-30, REQ-GEN-02

**Acceptance criteria**

- [ ] AC1: Adapters run established LLM evaluation tools (for example promptfoo, DeepEval, Ragas, Inspect) as runners.
- [ ] AC2: Deterministic metrics of these tools are compared with thresholds from the frozen plan; model-graded metrics are treated as judge results (REQ-EXEC-30, downgrade only).
- [ ] AC3: The tools' raw output is stored as evidence.

### REQ-EXEC-35 · External runner integrations

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-GEN-02, REQ-EXEC-06

**Acceptance criteria**

- [ ] AC1: Device farms (BrowserStack, Sauce Labs, LambdaTest) as execution targets for web and mobile.
- [ ] AC2: k6 for load, Lighthouse for frontend performance, axe-core for accessibility, Pact for API contracts.
- [ ] AC3: Each tool's own pass/fail output is the verdict source; thresholds come from the frozen plan.

### REQ-EXEC-36 · Blockchain (EVM) application testing

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-GEN-02, REQ-ENV-03

**Acceptance criteria**

- [ ] AC1: A local chain or a mainnet fork at a pinned block (Anvil or Hardhat), with time control.
- [ ] AC2: Contract calls through viem or ethers; dApp UI with a test wallet (Synpress).
- [ ] AC3: Evidence: transaction hashes, receipts, events and state before and after.
- [ ] AC4: Optional Foundry fuzz runs and Slither static analysis as additional runners.
- [ ] AC5: Only local or test networks; mainnet transactions are denied.

### REQ-EXEC-37 · Desktop application testing

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-EXEC-06, REQ-EXEC-09, REQ-GEN-02, REQ-ENV-12, INV-1

Windows, macOS and Linux desktop applications through the same plan, steps library and evidence as web and mobile.

**Acceptance criteria**

- [ ] AC1: A desktop runner drives applications through the operating system's accessibility layer: Windows UI Automation (Appium Windows driver or FlaUI), macOS (Appium Mac2 driver), Linux (AT-SPI).
- [ ] AC2: Electron apps run through Playwright's Electron support; Tauri apps through WebDriver.
- [ ] AC3: Image-based locating (template matching) is a fallback only; image assertions use a fixed similarity threshold from the frozen plan.
- [ ] AC4: Evidence: screenshots per step, video, the accessibility tree at a failure and the application's logs.
- [ ] AC5: Agent-driven screen control may explore the application and propose selectors during planning, never execute approved cases or decide results.
- [ ] AC6: The healer rules (REQ-EXEC-09) apply unchanged: selectors and waits only.

### REQ-EXEC-38 · Web: uploading and downloading files

- Status: accepted
- Priority: must
- Stage: later
- Related: REQ-EXEC-05, REQ-EVD-01, REQ-CFG-06, INV-4, INV-7, INV-8

Forms with attachments, imports and exports are common and cannot be tested today.

**Acceptance criteria**

- [ ] AC1: A step can upload one or more files into a file input or a drop zone; the files come from the project's fixtures (`.qa/fixtures/`) or are generated by code from the plan (size, type, name), never written by an agent at run time.
- [ ] AC2: A step can trigger a download and check the file against the plan: name, type, size range, SHA-256, and for CSV, JSON, XLSX, PDF and text files their content (rows, fields, text) through `verify()`.
- [ ] AC3: Uploaded and downloaded files are evidence in the manifest with their hashes; their text is masked before it is stored or shown.
- [ ] AC4: A file that does not arrive within the step's timeout, or that cannot be read, fails the step or makes the case BLOCKED with the reason; it is never PASSED.

### REQ-EXEC-39 · Web: frames, pop-ups and new tabs

- Status: accepted
- Priority: must
- Stage: later
- Related: REQ-EXEC-05, REQ-EXEC-21, REQ-ENV-03, INV-10

Payment widgets, embedded editors, captchas and many SSO logins live in iframes or pop-ups.

**Acceptance criteria**

- [ ] AC1: Selectors can address elements inside iframes, also nested ones (e.g. `frame:<selector> >> testid:pay`).
- [ ] AC2: A step can wait for a pop-up or a new tab, act in it and return to the opener; the evidence names which page each action happened in.
- [ ] AC3: Frames and pop-ups from hosts outside the environment allowlist are blocked and the step is BLOCKED with the host named; an allowlisted test host of a payment provider can be added per project.
- [ ] AC4: The healer may fix frame and page selectors like any other selector (REQ-EXEC-09); it never changes a `verify()`.

### REQ-EXEC-40 · Web: pointer, keyboard and scroll actions

- Status: accepted
- Priority: should
- Stage: later
- Related: REQ-EXEC-05, REQ-EXEC-09

**Acceptance criteria**

- [ ] AC1: Steps can hover, double-click, right-click, drag and drop (between elements or by an offset), and type key combinations.
- [ ] AC2: Steps can scroll an element or the page, scroll until an element appears (infinite lists) with a limit from the plan, and check scroll-dependent states.
- [ ] AC3: A drag or scroll that does not reach its target within the limit fails the step with the last position recorded.

### REQ-EXEC-41 · Mobile gestures

- Status: accepted
- Priority: must
- Stage: later
- Related: REQ-EXEC-06, REQ-EXEC-21

Lists, carousels, pull-to-refresh and maps need gestures.

**Acceptance criteria**

- [ ] AC1: Steps can swipe (direction, distance, speed), scroll until an element is visible with a limit, long press, double tap, pinch and zoom, and pull to refresh, on Android and iOS.
- [ ] AC2: Gestures address an element or the screen in relative coordinates, so they work across screen sizes of the device matrix (REQ-EXEC-20).
- [ ] AC3: The evidence shows each gesture's path on the step screenshot; a gesture whose target is not reached fails the step.

### REQ-EXEC-42 · Mobile: hybrid apps and WebViews

- Status: accepted
- Priority: should
- Stage: later
- Related: REQ-EXEC-06, REQ-EXEC-21

**Acceptance criteria**

- [ ] AC1: A step can switch between the native context and a WebView of the app and use web selectors inside it.
- [ ] AC2: A WebView that cannot be inspected (debugging disabled in the build) makes the case BLOCKED with the reason and how to enable it for test builds.

### REQ-EXEC-43 · Mobile: system features

- Status: accepted
- Priority: should
- Stage: later
- Related: REQ-EXEC-06, REQ-EXEC-14, REQ-EVD-03

**Acceptance criteria**

- [ ] AC1: Permission dialogs (camera, location, notifications, contacts) can be granted or denied as a plan step, or preset before the case starts.
- [ ] AC2: Deep links and universal/app links can open the app at a screen.
- [ ] AC3: Push notifications can be sent to the emulator or simulator (Firebase test tokens, `simctl push`) and their arrival and tap checked.
- [ ] AC4: Location, network conditions (offline, slow), biometrics (simulated success and failure) and the camera (a fixture image) can be set by a step on emulators and simulators.
- [ ] AC5: A feature the device or farm cannot provide makes the case BLOCKED with the reason; on real devices it can fall back to a manual step (REQ-EXEC-14).

### REQ-EXEC-44 · iOS on a local simulator

- Status: accepted
- Priority: should
- Stage: later
- Related: REQ-EXEC-06, REQ-GEN-06, REQ-ENV-06

**Acceptance criteria**

- [ ] AC1: On macOS with Xcode, iOS cases run on a local simulator through Appium XCUITest, started and stopped by QAJitsu like the Android emulator.
- [ ] AC2: The app is built or downloaded for the change SHA as for Android (`.app` for the simulator).
- [ ] AC3: Evidence: screen recording, page source and the simulator's system log, masked.
- [ ] AC4: Without macOS or Xcode, iOS cases run on a configured device farm or stay BLOCKED with the reason, as today.

### REQ-EXEC-45 · API: multipart and binary bodies

- Status: accepted
- Priority: must
- Stage: later
- Related: REQ-EXEC-04, REQ-EXEC-38, INV-8

**Acceptance criteria**

- [ ] AC1: Requests can send `multipart/form-data` (fields and files from fixtures), `application/x-www-form-urlencoded`, raw binary and plain text bodies.
- [ ] AC2: Binary responses (files, images, PDF) are kept as evidence with their hash and checked against the plan (type, size, hash, content for readable types).
- [ ] AC3: Request and response bodies in evidence are masked; binary bodies are stored as files, never inlined into the report.

### REQ-EXEC-46 · Waiting for asynchronous outcomes

- Status: accepted
- Priority: must
- Stage: later
- Related: REQ-EXEC-04, REQ-EXEC-05, INV-1, INV-4

Jobs, queues and eventual consistency: "the status changes within 30 seconds".

**Acceptance criteria**

- [ ] AC1: A step can poll an API call or a UI check until the planned expectation holds, with an interval and a timeout from the frozen plan.
- [ ] AC2: Every attempt is recorded as evidence; the report shows how long it took.
- [ ] AC3: An expectation not met at the timeout fails the step with the last observed value; polling never retries a failed `verify()` after the step ended.

### REQ-EXEC-47 · WebSocket and server-sent events testing

- Status: accepted
- Priority: should
- Stage: later
- Related: REQ-EXEC-04, REQ-ENV-03, INV-1, INV-8, INV-10

**Acceptance criteria**

- [ ] AC1: A step can open a WebSocket (with the test account's authentication), send messages and wait for messages matching the plan (fields, order, count) within a timeout.
- [ ] AC2: A step can subscribe to a server-sent events stream and check its events the same way.
- [ ] AC3: In web cases, the messages of the page's WebSockets can be checked as well as its HTTP traffic.
- [ ] AC4: Every frame sent and received is evidence, masked; hosts are checked against the environment allowlist, and a socket to another host is refused.
- [ ] AC5: A connection that cannot be opened or closes early makes the step fail or the case BLOCKED with the close code and reason.

### REQ-EXEC-48 · GraphQL testing

- Status: accepted
- Priority: should
- Stage: later
- Related: REQ-EXEC-04, REQ-EXEC-47, REQ-CTX-01, INV-4

**Acceptance criteria**

- [ ] AC1: The analyst and planner read the GraphQL schema from the repository (SDL files) or from introspection of an allowlisted test environment, and cite the operations and fields a case covers.
- [ ] AC2: Steps send queries and mutations with variables; subscriptions run over WebSocket (REQ-EXEC-47).
- [ ] AC3: A response is checked against the schema of the analysed commit, and the `errors` array is part of every result: errors where the plan expects data fail the step, even with HTTP 200.
- [ ] AC4: Expectations address response fields by path as for REST.

### REQ-EXEC-49 · gRPC testing

- Status: accepted
- Priority: should
- Stage: later
- Related: REQ-EXEC-04, REQ-CTX-01, INV-4, INV-10

**Acceptance criteria**

- [ ] AC1: The analyst and planner read `.proto` files from the repository (or server reflection on an allowlisted test environment) and cite the services and methods a case covers.
- [ ] AC2: Steps call unary methods and client, server and bidirectional streams, with metadata and the test account's credentials; TLS and plaintext per environment.
- [ ] AC3: Results record the gRPC status code, message, trailers and every streamed message as evidence, masked; expectations check status codes and message fields by path.
- [ ] AC4: A method or message type that does not exist in the analysed commit's protos makes the case BLOCKED before it runs.

### REQ-EXEC-50 · SOAP and XML APIs

- Status: accepted
- Priority: could
- Stage: later
- Related: REQ-EXEC-04, REQ-EXEC-45

**Acceptance criteria**

- [ ] AC1: Steps send SOAP 1.1/1.2 and plain XML requests; the planner reads WSDL and XSD files from the repository.
- [ ] AC2: Responses are validated against the WSDL/XSD of the analysed commit; SOAP faults are part of every result.
- [ ] AC3: Expectations address XML values by path (XPath) as JSON fields are addressed for REST.

### REQ-EXEC-51 · Event-driven APIs (message brokers)

- Status: accepted
- Priority: could
- Stage: later
- Related: REQ-EXEC-46, REQ-ENV-03, INV-8, INV-10

**Acceptance criteria**

- [ ] AC1: Steps can publish to and consume from Kafka, RabbitMQ (AMQP), MQTT and cloud queues (SQS, Pub/Sub) of the test environment; the planner reads AsyncAPI documents from the repository.
- [ ] AC2: A step waits for a message matching the plan on a topic or queue within a timeout, on its own consumer group or queue, so it never takes messages from the application.
- [ ] AC3: Messages sent and received are evidence, masked; brokers outside the environment's allowlist are refused.

### REQ-EXEC-52 · Maestro runner adapter

- Status: accepted
- Priority: should
- Stage: later
- Related: REQ-EXEC-06, REQ-EXEC-41, REQ-GEN-02, REQ-GEN-11, INV-1, INV-4

Maestro runs mobile (Android, iOS, React Native, Flutter) and web flows from YAML; many teams already have Maestro flows.

**Acceptance criteria**

- [ ] AC1: A runner adapter executes mobile cases with Maestro as an alternative to Appium, chosen per project or per case type.
- [ ] AC2: The author writes Maestro flows from the approved plan; every planned expectation is an assertion of the flow, checked by code against the plan before the run (as REQ-VER-23 does for specs), and expected values come from the plan.
- [ ] AC3: The verdict comes from Maestro's own results (JUnit report and exit code); screenshots, recordings and logs Maestro writes are collected into the manifest with their hashes.
- [ ] AC4: Existing Maestro flows in the tests repository are read as a cited, untrusted planner source and can be run as regression cases.
- [ ] AC5: The healer may change selectors and waits in a flow only; a changed assertion is rejected like a changed `verify()`.
- [ ] AC6: Maestro Cloud is supported as a device farm target with its results downloaded as evidence.
