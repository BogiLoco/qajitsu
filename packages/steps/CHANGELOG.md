# @qajitsu/steps

## 0.1.0

### Minor Changes

- 18f9746: Failure screenshots mark the failing element (REQ-EVD-08): when a web or mobile step fails, a copy of its screenshot gets a numbered red box around each element whose assertion failed and each region that differs from the visual baseline (`<step>-annotated.png`, with `<step>-annotations.json` listing field, expected and actual value); a missing element is noted, and with a baseline the baseline copy is marked too. The original screenshot is unchanged and no status changes. `report.html`, `qj evidence --failed`, the ticket comment and `qj bug` show the annotated copy first. New `ScreenBox`/`ScreenMark` types, `regions` on image comparisons, optional `bounds` on UI drivers and `annotate` on the case runtime.
- 6da421c: Selectors for any web or mobile application (REQ-EXEC-21): `web.test_id_attribute` (e.g. `data-qa`) for `testid:`,
  the element inventory and snapshots; new selector kinds `placeholder:`, `alt:`, `title:`, `id:` (web) and `id:`,
  `xpath:` (native apps); on Android `testid:` also finds the resource id. The inventory finds Android `@+id`, SwiftUI
  `.accessibilityIdentifier`, Flutter `Semantics(identifier:)`, `Key` and `ValueKey`. Static checks accept only the
  kinds of the case's platform and flag `xpath:` for review. Prompts list selector kinds by stability and no longer use
  demo-shop ids. A screen without any addressable element makes the case BLOCKED with that reason.
- fbf85d7: API bodies beyond JSON (REQ-EXEC-45): specs send `multipart/form-data` (text fields and files of the plan by key),
  `application/x-www-form-urlencoded`, raw binary from a plan file and plain text through `client.multipart()`,
  `client.form()`, `client.binary()` and `client.text()`. A response that is a file (an attachment, or a type that is not
  text or JSON) is kept as evidence with its SHA-256 and checked by the existing `download.*` expectations; the call's
  record points to the file instead of inlining it, and form fields, text bodies and cURL lines are masked. The static
  checks require literal plan file keys, and an API request in a step satisfies a planned download. The author prompt
  explains the helpers. `plannedFields` moved to `@qajitsu/core` (re-exported by the verifier).
- c3aea49: Snapshot of the running application (REQ-EXEC-22). Drivers list the elements a page or screen shows
  (`UiDriver.elements`, from Playwright's accessibility snapshot and test ids, or from the Appium page source). Before
  writing specs, `qj run` records each web case's pages and the app's first screen and gives the author every element
  with the selectors that find it; selectors found nowhere go back to the author once. A failed UI attempt keeps
  `failure-elements.json` for the healer, which now heals mobile cases too. `qj plan --env/--snapshot` records the
  environment's pages when the code is not available, and the plan check flags elements no recorded page shows.
- 016d940: Waiting for asynchronous outcomes (REQ-EXEC-46): a plan step may set `wait: { timeout_s, interval_s }`. The runtime,
  in process and in the sandbox, repeats the step's actions and checks until every planned expectation of the step
  holds or the time is up; the interval does not count against the case's time limit. Every round is evidence
  (`<step>-wait.json`), the attempt records `wait: { waitedMs, rounds, met }` per step and `report.html` shows it; a
  check not met in time fails with the last observed value, and a round that leaves out a planned check never counts as
  met. The planner prompt and the plan review show the wait. The demo shop's documents are processed for two seconds
  (BUG-22: never ready).
- 730f710: Logins for real web applications (REQ-EXEC-67): the HTTP login can use the `Set-Cookie` of its response as the
  session (no `token_path`), login scripts can print `cookies` or a Playwright `storage_state`, and `web_session:
  { storage: cookies }` makes `ui.as(alias)` load them for the application's origin only. `ui.fillSecret(selector, alias,
  "password" | "username")` types an account's secret into a login form: the runner resolves it, screenshots black the
  field out, and specs, agents, evidence and the journal see only the mask. Traces kept as evidence are now masked,
  including sensitive headers and cookies the application set during the test. `zip`/`unzip` moved to
  `@qajitsu/core` (still exported by `@qajitsu/report`). Demo shop: sign-in with an HttpOnly cookie and BUG-18 (DEMO-13).
- 59cba3d: Touch gestures and emulated phones (REQ-EXEC-41, REQ-EXEC-63): `ui.tap`, `ui.doubleTap`, `ui.longPress`, `ui.swipe`,
  `ui.pinch` and `ui.pullToRefresh`, planned relative to their target (an element or the screen) so they work on every
  screen size; native apps run them as W3C touch actions through Appium and gain `ui.scrollUntil`; web pages run them as
  Chromium touch events. Each gesture's path is evidence and is drawn on the step's screenshot. `web.matrix.devices`
  adds emulated devices from Playwright's list (`iPhone 15`, `Pixel 7`) next to the viewports; reports name them as
  emulated. Demo shop: a touch gallery with BUG-20 (DEMO-15).
- 6abb72b: GraphQL subscriptions over WebSocket (REQ-EXEC-48/AC2).
  
  - **Specs:** `api.subscribe(query, variables, { path })` opens a WebSocket that speaks graphql-transport-ws. Every
    pushed payload is a stream message (`messages.0.data.priceChanged.price`).
  - **Checks:** the verifier checks the subscription's query and every payload against the schema, like a query's.
  - **Blocked:** a step planned as GraphQL that sends its query without `api.graphql()` or `api.subscribe()`.
- 9e47208: GraphQL testing (REQ-EXEC-48).
  
  - **Schema:** `repos.<alias>.graphql` names the schema of the analysed commit: an SDL file in the repository, or an
    endpoint path such as `/graphql`, which is introspected on the test environment.
  - **Planning:** the planner sees its operations. A plan step names `graphql: { operation: "Query.product" }`, and a
    draft that cites an operation the schema does not have goes back to the planner.
  - **Specs:** they call `api.graphql(query, variables)`.
  - **Checks after each attempt:**
    - an `errors` array where the plan expects data fails the step, even with HTTP 200;
    - data that does not fit the schema's types fails it too;
    - a query that does not fit the schema, or skips the planned operation, makes the case BLOCKED as the spec's error.
  - **Demo shop:** a GraphQL endpoint with DEMO-18, BUG-24 (the price as text) and BUG-25 (an error next to the data).
- 2d298c8: Live progress of a run (REQ-OBS-09): `qj run` prints each case start with a counter, each step and each attempt outcome as plain lines; the runner journals `step.start` as steps begin. `qj watch <TICKET>` serves a page on 127.0.0.1 with the cases, the step running now, the latest screenshot (`<run>/live/`, not evidence) and preliminary outcomes, then the computed statuses; a run that stopped is shown as stopped. New optional `progress` on `AttemptRequest` (`AttemptProgress`) and `onScreenshot` on the case runtime; the guard protects `live/`.
- dcca1a0: Locale runs (REQ-EXEC-14): project `locales` with time zones; plan cases list their locales and give per-locale expected values (`expect.by_locale`, only planned keys); each locale runs with the plan resolved for it (`planForLocale`), the browser locale and time zone and an `Accept-Language` header; the case is PASSED only if every locale passed; reports show the status per locale.
- 3c66a3b: Manual steps (REQ-EXEC-11, ADR-0008): plan steps can be `manual: true` with instructions; the run asks a tester in the terminal or waits for `qj answer` in CI; the answer is an assertion with `source: manual`, who and when, plus evidence; failed → FAILED, no answer → BLOCKED; reports name who performed each manual step; agents cannot answer (guard). `manual.timeout_s`.
- 69a6c09: Message capture (REQ-ENV-08): `messages:` (webhook.site, hosted or self-hosted) gives every case its own inbox; plan steps can expect a message (`expect.message`: to, subject, body, within_s), specs use `inbox.address()` and `inbox.wait()`, the trusted runtime matches against the plan, keeps the masked message as evidence and fails the step when none arrives; inboxes are deleted when the run ends. Spec type checks now read the `@qajitsu/steps` sources in the monorepo.
- 52ebfb2: Analysis of the recorded network traffic, AC3..AC7 (REQ-EVD-09).
  
  Every web attempt writes `network-analysis.json`, and each finding names its entry in `network.har`. The report
  lists the findings as observations, never as results:
  
  - **Performance:** the number, size and slowest requests per step, with warnings from
    `observations.network.budget` or a case's `network_budget`.
  - **Security:** tokens and personal data in URLs, mixed content, missing security headers, and cookies without
    `HttpOnly` or `Secure`.
  - **Contract (opt-in):** with `observations.network.response_bodies.enabled`, the page's JSON responses are kept
    masked and size-limited, and checked against the OpenAPI description.
  - **Changes since the last run of the same approved plan:** endpoints that appeared, disappeared or changed status
    or shape, and steps that became much slower.
- 32c1b62: Installable web apps and offline mode (REQ-EXEC-65): a web case can allow service workers with
  `browser.service_workers: true` (Chromium only, where every request of the worker stays on the allowlist; elsewhere the
  case is BLOCKED with the reason), a step can go offline and back with `ui.setOffline(true|false)`, and `manifest.*`
  checks the page's web app manifest (`name`, `short_name`, `start_url`, `display`, number of `icons`) and whether a
  service worker controls the page (`manifest.controlled`). The author's prompt now also lists `ui.advanceTime()`.
- 254a8c8: Shared environments (REQ-EXEC-54). `execution.rate_limit` limits the requests per second to one host and the cases at
  once, across every lane of a run. A `429` or `503` with `Retry-After` is waited out and retried, only for a request
  that is safe to repeat: a GET, or a request of a plan step with `idempotency_key: true`, which also carries an
  `Idempotency-Key` that stays the same on retries. Every retry is evidence. A case still rate limited after its budget
  is BLOCKED as "rate limited", never FAILED or PASSED.
- 353a30c: Several users in one web case (REQ-EXEC-62): `ui.session(name)` opens another browser session, logged in as the test
  account the case names under that key in its data (`buyer: user:standard`), with its own cookies and storage, and
  switches between sessions; each holds its own pool account, screenshots and the action log name their session.
  Snapshots note whether a page exposes the application's test hook, and a plan expecting `state.*` from pages without
  one is flagged. Demo shop: messages between shoppers with BUG-19 (DEMO-14).
- 7bdae8c: SOAP and XML APIs (REQ-EXEC-50).
  
  - **Contract:** `repos.<alias>.wsdl` and `repos.<alias>.xsd` name the WSDL and XML Schemas of the analysed commit.
  - **Planning:** the planner sees the WSDL's operations and the XSDs' elements. A plan step names
    `soap: { operation: "GetPrice" }` and expects XPaths under `xml`; a draft citing an operation the WSDL lacks goes
    back to the planner.
  - **Specs:** `api.soap(path, body, { action, version })` sends SOAP 1.1 or 1.2, and `res.xml(xpath)` reads an XPath.
    `verify(step, "xml.<xpath>", ...)` reads the value from the response itself.
  - **Checks after each attempt:**
    - an unplanned fault fails the step, even with HTTP 200;
    - an answer outside the WSDL or XSD fails it too;
    - a request without the planned operation, or a SOAP step that skips `api.soap()`, makes the case BLOCKED.
  - `checkAttempt` of the API runner may be async.
  
  New dependencies:
  
  - `@xmldom/xmldom` (MIT): an XML parser in pure JavaScript, no native code;
  - `xpath` (MIT): XPath 1.0 over that DOM, loaded untyped so its DOM types stay out of the build;
  - `xmllint-wasm` (MIT): libxml2's XSD validation compiled to WebAssembly, no native build or postinstall.
  
  All are pinned in the lockfile.
- 28ab015: Automated logins for test environments (REQ-EXEC-55): accounts can carry a TOTP seed (`totp: secret://...`) whose
  codes QAJitsu computes when they are typed (`ui.fillSecret(sel, alias, "totp")`, `{{totp}}`, `QAJITSU_TOTP` for login
  scripts); `ui.fillCode(sel)` types the code of the e-mail or SMS the step's plan expects (`message.code` pattern), and
  no message in time fails that check; `login: { browser: ... }` runs SSO through the identity provider's pages with
  redirects, keeps only the application's own session, loads only allowlisted provider origins and reuses one login per
  account and run; `test_headers` sends the application's test mechanisms (a captcha bypass) to its own origin only.
  Captchas are never solved. The planner's answer gets missing evidence filled by code; plan flags about texts the
  recorded pages show differently no longer block approval. Demo shop: a fictional identity provider with TOTP.
- 5c6c8f2: Stage 3: `qajitsu run` executes the approved plan against a provided environment. Adds the steps runtime
  (`step()`, `verify()`, `plan.expect()`, masked API evidence with cURL), the author agent with static checks
  (lint, plan coverage, assertion lock, tsc), the sandboxed API runner on Playwright APIRequestContext with retries,
  the local evidence store with a SHA-256 manifest, environment profiles with allowlist, production ban, health and
  version checks and framework login of account aliases, status evaluation and publish gates in the verifier, and
  CSV, XLSX and self-contained HTML reports with validated summaries.
- 76edd93: Stage 5: web and mixed tests. The trusted parent drives a Playwright browser for sandboxed specs (ADR-0004) with a
  screenshot per step, full-page screenshot, DOM, video and trace on failure, HAR and console per case; `ui.*` in the
  steps API and `elements`/`texts` expectations in plans; the healer limited to selectors and waits by an AST diff
  (healed passes are NEEDS_REVIEW); parallel workers; `qajitsu logs`, a timeline and a transition graph in report.html;
  `qajitsu evidence` opens the report, videos and traces; `qajitsu pull` downloads CI evidence from Jira; ffmpeg video
  compression before upload. `CaseRuntime.endStep`, `verify` and `finish` are now async.
- ee9111a: Stage 8: mobile. `@qajitsu/adapter-runner-mobile` drives Android (UiAutomator2) and iOS (XCUITest, device farms) apps
  through Appium with WebdriverIO from the trusted parent; specs use the same `ui.*` API plus `ui.back()`. QAJitsu
  starts and stops the Android emulator and the Appium server, takes the app from CI artifacts of the change SHA
  (`downloadArtifact` for GitHub Actions and GitLab CI), a worktree file or a build command, runs mobile cases
  sequentially on the device, and records a screenshot per step, the screen recording, logcat/syslog and the page
  source on failure. Unavailable platforms (iOS without Xcode or a farm) make cases BLOCKED with the reason. New
  `mobile` config section; `UiDriver` gains `back()`.
- 0ecb802: Test data per case (REQ-EXEC-53): a plan case lists the records it needs in `test_data`. Before each attempt the
  runner creates them through the application's API (`test_data.kinds.<kind>.create/remove` in the project config, as
  an account alias) or the project's data hook, each marked `qj-<ticket>-<run>-<case>-a<attempt>`, gives them to the
  spec as `data.get("<name>")` and removes them afterwards in reverse order (`qj run --keep` leaves them). Data that
  cannot be created ends the attempt before any step (BLOCKED); what was created and removed is masked evidence
  (`test-data.json`); a failed removal is a journal warning. `qj data clean [<TICKET>] [--run <id>] [--all]` removes
  leftovers by marker through `test_data.cleanup` or the hook. The planner sees the project's kinds and code refuses
  others; static checks require `data.get()` to name a record of the case. `--keep` now applies to every run.
- 08e6842: The recorded traffic is read by code (REQ-EVD-09/AC1+AC2): every request of the page is tied to its step; a failed or
  blocked step lists the requests that went wrong (5xx, 4xx, timeouts, connection errors, allowlist refusals, CORS,
  redirects to login) in `steps[].network`, `S1-network.json` and next to the failure in the report, and the failure
  hints get it as structured data. Every attempt records the pages and endpoints it reached (`attempts[].requests`),
  and the report lists which case reached which endpoint of the change. Web cases can check the page's WebSocket
  messages (REQ-EXEC-47/AC3): `websocket.received.<n>` and `websocket.sent.<n>`, frames kept per step. Plan checks also
  flag a dialog without an answer, invented manifest elements, and count a changed page as covered by a web case that
  opens it. The demo shop gets a support chat over a WebSocket with BUG-17.
- 24308e8: Visual regression (REQ-EXEC-12): `expect.visual` compares a step's screenshot (masked regions) with the baseline in `.qa/baselines/` per browser, viewport and locale; above the threshold → FAILED with baseline, screenshot and diff; no baseline → NEEDS_REVIEW (`review` assertions never PASS) with the screenshot proposed; `qj baseline accept` (manifest-checked) is the only way baselines change. New dependencies in runner-web: pngjs 7 (MIT), pixelmatch 8 (ISC).
- c2d6ffe: Web cases can upload and download files (checked by name, type, size, hash and CSV/JSON/XLSX/PDF content), work
  inside iframes, pop-ups and new tabs, hover, double and right click, drag and drop, press keys, scroll infinite lists,
  reach into Shadow DOM, check canvas content through the application's test hook or an element screenshot, answer
  browser dialogs, run at a planned time and move it, use browser permissions and a location, and reach staging behind
  HTTP authentication. The assertion lock now also compares actions and control flow, so a healer cannot change what a
  test does.
- 1fc2482: WebSocket and server-sent events in API steps (REQ-EXEC-47).
  
  - **Plan:** a step expects `messages` by position (`"0.type": "price"`, `"count": 2`) within `stream.timeout_s`.
  - **Specs:** `api.websocket(path)` with `send()`, and `api.events(path)`.
    `verify(step, "messages.<n>.<path>" | "messages.count", ...)` waits for the messages itself.
  - **Trusted process:**
    - opens every stream with the account's headers, only to origins of the allowlist;
    - keeps every frame as masked evidence.
  - **Outcomes:**
    - a message that does not come fails the step, with the close code and reason;
    - a stream that cannot be opened is BLOCKED.
  - No new dependency: Node's built-in WebSocket client and fetch.

### Patch Changes

- 5661a8c: Core interfaces follow the real seams (ADR-0005): `Runner` is replaced by `AttemptExecutor` with `AttemptRequest`,
  `AttemptRecord` and `EvidenceItem` now in `@qajitsu/core`; `EnvProvider.start()` returns a handle with `baseUrl`,
  `health`, `deployedSha`, `stubs` and `stop()`, implemented by `createRemoteEnvProvider` and
  `createComposeEnvProvider`; `ModelProvider` is the registry shape (`resolve`, `forRole`) that `ModelRegistry`
  extends. Every interface has a shared contract suite in `tests/contract/`.
- 3a9ffcc: The element inventory records the platform of each id (web, Android, iOS) and the plan check accepts only ids of the
  case's own platform. Specs of mobile cases are rejected statically when they use what only a browser has (`ui.as`,
  `ui.select`, `ui.goto` without `mobile.deep_link_scheme`, `css:` or `role:` selectors), so the author fixes them
  before the run. A mobile step may check an element before any action, since the app is open from the start.
- Updated dependencies [322dcb3]
- Updated dependencies [18f9746]
- Updated dependencies [6da421c]
- Updated dependencies [fbf85d7]
- Updated dependencies [c3aea49]
- Updated dependencies [aabdb96]
- Updated dependencies [44e4d71]
- Updated dependencies [016d940]
- Updated dependencies [7384885]
- Updated dependencies [f65a8a4]
- Updated dependencies [9a6d3dc]
- Updated dependencies [f3cf459]
- Updated dependencies [7a85b02]
- Updated dependencies [71f8b88]
- Updated dependencies [f431a44]
- Updated dependencies [e6bc0fd]
- Updated dependencies [b85692f]
- Updated dependencies [8125f74]
- Updated dependencies [a3ab148]
- Updated dependencies [cb3a977]
- Updated dependencies [068ee8d]
- Updated dependencies [4585559]
- Updated dependencies [e387a21]
- Updated dependencies [20ae077]
- Updated dependencies [730f710]
- Updated dependencies [5661a8c]
- Updated dependencies [ac46226]
- Updated dependencies [47fac1e]
- Updated dependencies [7de9efc]
- Updated dependencies [c268171]
- Updated dependencies [693612b]
- Updated dependencies [b17d302]
- Updated dependencies [1b0fc13]
- Updated dependencies [f26a0ad]
- Updated dependencies [1595612]
- Updated dependencies [1049e36]
- Updated dependencies [0a4b201]
- Updated dependencies [59cba3d]
- Updated dependencies [856f330]
- Updated dependencies [44af6d7]
- Updated dependencies [9e47208]
- Updated dependencies [2abbf5d]
- Updated dependencies [2acbc70]
- Updated dependencies [0efd727]
- Updated dependencies [d5a352c]
- Updated dependencies [1d4802f]
- Updated dependencies [de3be18]
- Updated dependencies [e27cccf]
- Updated dependencies [2d298c8]
- Updated dependencies [dcca1a0]
- Updated dependencies [3c66a3b]
- Updated dependencies [112d074]
- Updated dependencies [b13168a]
- Updated dependencies [69a6c09]
- Updated dependencies [52ebfb2]
- Updated dependencies [8a03150]
- Updated dependencies [adb1475]
- Updated dependencies [24d21c4]
- Updated dependencies [be9804d]
- Updated dependencies [3ec9d51]
- Updated dependencies [9876a31]
- Updated dependencies [1384f6e]
- Updated dependencies [016c6f1]
- Updated dependencies [a22d313]
- Updated dependencies [df9aa5c]
- Updated dependencies [ea69cf8]
- Updated dependencies [32c1b62]
- Updated dependencies [254a8c8]
- Updated dependencies [6fb3db3]
- Updated dependencies [6f00289]
- Updated dependencies [353a30c]
- Updated dependencies [7bdae8c]
- Updated dependencies [28ab015]
- Updated dependencies [5c6c8f2]
- Updated dependencies [cbd6fbb]
- Updated dependencies [5c6c8f2]
- Updated dependencies [5c6c8f2]
- Updated dependencies [b447614]
- Updated dependencies [76edd93]
- Updated dependencies [ef6861b]
- Updated dependencies [15a7965]
- Updated dependencies [ee9111a]
- Updated dependencies [b5b577c]
- Updated dependencies [0ecb802]
- Updated dependencies [fc55fef]
- Updated dependencies [08e6842]
- Updated dependencies [5cd2348]
- Updated dependencies [24308e8]
- Updated dependencies [c2d6ffe]
- Updated dependencies [1fc2482]
  - @qajitsu/core@0.1.0
