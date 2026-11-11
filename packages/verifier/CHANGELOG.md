# @qajitsu/verifier

## 0.1.0

### Minor Changes

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
- 44e4d71: Approval flow with model approvers (REQ-PLAN-10, ADR-0010): `approval.flow` lists person and model steps; a model
  approver (another model than the planner) approves, asks for a revision or hands over to a person, and code hands
  over plans with flagged values or open questions without asking it. Every decision is kept in `run.json`
  (`approvals`) and the journal with the plan, prompt and answer hashes; `qj approve --person` lets a person decide at
  once. Plans approved by a model only are marked in the matrix, report, junit and Jira comment, `approval.model_only:
  review` turns their PASSED into NEEDS_REVIEW, the `approval-intact` gate and `qj audit verify` check the records, and
  `approval.jira: comment` posts the plan and each decision as separate comments. The file publisher keeps named
  comments in their own files.
- 7384885: Audit trail, signed test certificates, test code quality gate and human spec review.
  
  - REQ-VER-16: every model call is stored masked in `journal/agents.jsonl` (prompt, answer, tool calls with arguments
    and results, provider, model version, tokens) with its hash in the journal; compose environments record container
    image digests; `qj audit trail` lists every file of a run with its SHA-256 and the gaps; `qj audit export` writes
    one secret-scanned zip with `SHA256SUMS` and a README.
  - REQ-VER-15: `certificate.signing_key` (Ed25519, from the secret provider; `qj audit keygen`) signs an in-toto
    statement in a DSSE envelope over the run's complete audit trail with an RFC 6962-style Merkle root; `qj publish`
    and `qj audit certify` issue it, `report.html` and the Jira comment show it, `certificate.required` stops a
    publication without one; `qj verify-report` checks a run folder or export offline with keys from `--key` or
    `.qa/keys/`. Reports render deterministically so a certificate stays valid. Schema:
    `schemas/test-certificate.v1.schema.json`.
  - REQ-VER-21: `tools/verify-certificate.mjs`, a verifier with Node.js built-ins only, and the format guide.
  - REQ-VER-23: generated specs pass a test code quality gate (constant or skippable assertions, swallowed errors,
    disabled cases, whole-page checks) before they run.
  - REQ-VER-24: `qj run --review-specs` and `spec_review` let a person accept or send back each generated spec;
    `qj review-spec` decides without a terminal.
  - `qj init` names the same missing tools as `qj doctor`; cases not chosen with `--cases` stay NOT_RUN when the
    environment fails.
- 9a6d3dc: Why a case was BLOCKED (REQ-VER-13): after the run, the triage model suggests the likely cause of every BLOCKED case
  (spec, plan, environment, tooling, configuration) with a next step, citing the error, spec lines, steps, evidence or
  logs. Code keeps only hints whose citations exist; they are printed under the result table, shown in the matrix and
  report (`checks/blocked.json`) and never change a status. Switched with `verification.triage`.
- 7a85b02: Browser and viewport matrix (REQ-EXEC-13): `web.matrix` runs web cases in every browser × viewport combination with results and evidence per combination; `combineStatuses` makes a case PASSED only when every combination passed; a missing browser is BLOCKED with the install command; matrix, report and Jira comment show the status per combination.
- 730f710: Logins for real web applications (REQ-EXEC-67): the HTTP login can use the `Set-Cookie` of its response as the
  session (no `token_path`), login scripts can print `cookies` or a Playwright `storage_state`, and `web_session:
  { storage: cookies }` makes `ui.as(alias)` load them for the application's origin only. `ui.fillSecret(selector, alias,
  "password" | "username")` types an account's secret into a login form: the runner resolves it, screenshots black the
  field out, and specs, agents, evidence and the journal see only the mask. Traces kept as evidence are now masked,
  including sensitive headers and cookies the application set during the test. `zip`/`unzip` moved to
  `@qajitsu/core` (still exported by `@qajitsu/report`). Demo shop: sign-in with an HttpOnly cookie and BUG-18 (DEMO-13).
- c268171: Exploratory sessions: `qj explore <TICKET> --goal "..." [--time-box <min>] [--max-steps <n>]` lets the new `explorer`
  agent explore the application through browser actions QAJitsu performs and records (screenshots, video, trace,
  network, console in the evidence manifest). Observations cite the recorded actions as steps to reproduce; the session
  writes `explore/<session>/report.html` and `report.md` for review and never produces statuses. `qj explore promote`
  turns an observation into a draft plan case with a new `observation` source kind; it runs only after approval.
  `explore/` is protected from agent writes.
- b17d302: Exploration before planning (REQ-PLAN-11): `qj explore review` lets a person accept or reject what exploratory
  sessions found (observations, findings, not-done checklist items), keep accepted ones in the knowledge base with
  `--keep`, and `qj plan` offers the planner only the accepted items. Cases may cite them as `{kind: explore}`; code
  refuses items not accepted, turns cases with no source for their expected result into open questions, and lists
  accepted not-done items no case covers.
- 1595612: Found by exploratory testing of every qj command:
  
  - `qj work`, `env`, `knowledge`, `audit`, `telemetry`, `ci` and `baseline` alone say which subcommands they have
    (they printed help and exited 3 without saying what was missing).
  - `qj runs` shows one "Last stage" column, e.g. `fetch (completed)`, instead of "completed | fetch".
  - A run without an approved plan says how to write and approve one.
  - `RUN_ALREADY_EXECUTED` names how to start a new run: `qj fetch`, then `qj approve --reuse-from <run>`.
  - The table `qj run` prints shows the hints for FAILED cases, as it does for BLOCKED ones.
  - A plan whose api case calls an endpoint that answers 401 without login, and names no test account (`data.user`),
    is flagged before approval (REQ-PLAN-09/AC9): a local planner left the account out and every call failed with 401,
    looking like a product bug.
- dcf7a1e: A spec for a case that runs as a test account must log in as it (`api.as(...)` or `ui.as(...)`); one that never does
  is refused and sent back to the author like a missing `verify()`, as is one that drops the client `api.as()` returns or calls the anonymous `api`. A local author wrote `api.get("/cart")` for a case
  with `data.user`, every call got 401, and the cases ended FAILED as if the cart were broken. The demo shop's OpenAPI
  documents login and the 401 of every protected operation, and the plan check also reads `security`.
- 0a4b201: Bug fix verification (REQ-VER-11): plan cases can be marked `reproduces`; `qj run <TICKET> --build --fix-check` runs
  the approved plan on the fix, then creates a sibling run on the commit the change branched from (`GitRepos.mergeBase`)
  with the same approved plan (reused by SHA-256) and the same specs. `evaluateFixCheck` verifies the fix only when every
  reproduction case is FAILED before and PASSED after with identical specs; the report and the Jira comment show both.
- 59cba3d: Touch gestures and emulated phones (REQ-EXEC-41, REQ-EXEC-63): `ui.tap`, `ui.doubleTap`, `ui.longPress`, `ui.swipe`,
  `ui.pinch` and `ui.pullToRefresh`, planned relative to their target (an element or the screen) so they work on every
  screen size; native apps run them as W3C touch actions through Appium and gain `ui.scrollUntil`; web pages run them as
  Chromium touch events. Each gesture's path is evidence and is drawn on the step's screenshot. `web.matrix.devices`
  adds emulated devices from Playwright's list (`iPhone 15`, `Pixel 7`) next to the viewports; reports name them as
  emulated. Demo shop: a touch gallery with BUG-20 (DEMO-15).
- 44af6d7: Every run ends with a GO / NO-GO / NO DECISION decision computed by code from the statuses and the plan's
  priorities, with the cases that caused it, in the terminal, matrix, report, junit, `qj evidence`, `qj export` and the
  ticket comment; `decision:` in the project config can tolerate statuses of lower priority cases (REQ-PUB-10).
  An invalid configuration now names every problem in its message for every command, and `qj doctor` reports it once.
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
- 2abbf5d: Import existing manual test cases (REQ-CTX-08): `test_cases:` in the project configuration reads the cases linked to a ticket from Xray Cloud, Zephyr Scale, TestRail or a CSV/Excel file during `qj fetch` into `imported/cases.json`. The planner gets them as untrusted data and cites them as `{kind: imported, id}`, which code checks against the imported ids; a source that cannot be reached is reported and planning continues. The guard protects `imported/`. New package `@qajitsu/adapter-testcases`, `TestCaseSource` interface and `xlsxRows` in core.
- 2acbc70: Jira workflow: `workflow:` maps the team's statuses per role; `qj publish` moves the ticket by the computed result
  (all PASSED to "passed", FAILED back to the change's author, anything else stays in testing with a label);
  `qj workflow sync` takes plan approval from `/qj approve v<N>`, `/qj revise` and `/qj reject` comments by a Jira
  group with reminders; one active run per ticket and a daily limit; `qj doctor` checks the mapping. Also: cost per
  verified ticket with cache and dated prices, stage timing and budgets, plan quality, agent scorecard and `qj feedback`,
  prompt caching and input limits, the ticket readiness gate, and `qj reproduce` for certified runs.
  
  Tickets are picked up from the start status (`qj workflow poll`, `qj workflow serve` with a signed webhook).
  Certificates get trusted RFC 3161 timestamps (`certificate.timestamp`, `qj audit timestamp`, checked by
  `qj verify-report --tsa-ca` and `tools/verify-certificate.mjs`), and certified runs can be kept in write-once storage
  on S3 Object Lock (`archive`, new plugin `@qajitsu/adapter-evidence-s3`, `qj audit archive`); locked runs are kept by
  cleanup.
- 0efd727: Analyst and planner search the project's documentation with `search_docs` (all of it in the prompt for small knowledge bases). Plans cite documentation as `{"kind":"doc","chunk","quote"}`; code checks the quote verbatim against the chunk the run was given (`knowledge/chunks.json`, protected from agents) and fills in path, section, date and a "possibly outdated" warning. `knowledge.auto_sync` syncs sources before `qj plan`.
- 3c66a3b: Manual steps (REQ-EXEC-11, ADR-0008): plan steps can be `manual: true` with instructions; the run asks a tester in the terminal or waits for `qj answer` in CI; the answer is an assertion with `source: manual`, who and when, plus evidence; failed → FAILED, no answer → BLOCKED; reports name who performed each manual step; agents cannot answer (guard). `manual.timeout_s`.
- 112d074: Map as planner input (REQ-OBS-08): `qj plan` builds the application map of every past run and stores the part around the change in `map/around.json` (touched screens and endpoints, never tested ones next to them, transitions from or to them). The planner sees it as untrusted data and may add regression cases citing `{kind: map, id}`, checked by code; the guard protects `map/`. New `mapAroundChange` in the report package and `collectAppMap` behind `qj map`.
- 69a6c09: Message capture (REQ-ENV-08): `messages:` (webhook.site, hosted or self-hosted) gives every case its own inbox; plan steps can expect a message (`expect.message`: to, subject, body, within_s), specs use `inbox.address()` and `inbox.wait()`, the trusted runtime matches against the plan, keeps the masked message as evidence and fails the step when none arrives; inboxes are deleted when the run ends. Spec type checks now read the `@qajitsu/steps` sources in the monorepo.
- 3a9ffcc: The element inventory records the platform of each id (web, Android, iOS) and the plan check accepts only ids of the
  case's own platform. Specs of mobile cases are rejected statically when they use what only a browser has (`ui.as`,
  `ui.select`, `ui.goto` without `mobile.deep_link_scheme`, `css:` or `role:` selectors), so the author fixes them
  before the run. A mobile step may check an element before any action, since the app is open from the start.
- 83fcb63: Numbers written as text in plan expectations (`total: "1.01"`) are converted by code when the OpenAPI document says
  the field is a number or an integer; `qj plan` lists every conversion and the planner is not sent back for them
  (REQ-PLAN-12).
- 7647358: Coverage is computed by code (REQ-PLAN-14): every acceptance criterion and every changed endpoint needs a case, an
  existing test or an exclusion with a reason; `qj plan` lists what is not covered, approving it needs
  `--confirm-uncovered` (recorded), and a model approver hands such a plan to a person.
- be9804d: Plans must be checkable: code flags placeholders instead of expected values, fields that are not in the OpenAPI
  response (or have another type), steps with a description only and `testid:` selectors the code does not define;
  the planner gets one automatic round to fix them, the review lists what remains and approving it needs a separate
  confirmation (`qj approve --confirm-placeholders`), recorded in `run.json`. Planner and author get the element ids and
  page paths found in the worktree. Fixes from the demo walkthrough: element expectations shown in the plan review, the
  planner and author prompts describe web and mobile expectations and specs, `verify()` outside its step is rejected
  statically, a reused plan brings its analysis, `qj watch` shows the run's statuses, screenshots go to vision models
  as file parts.
- 32c1b62: Installable web apps and offline mode (REQ-EXEC-65): a web case can allow service workers with
  `browser.service_workers: true` (Chromium only, where every request of the worker stays on the allowlist; elsewhere the
  case is BLOCKED with the reason), a step can go offline and back with `ui.setOffline(true|false)`, and `manifest.*`
  checks the page's web app manifest (`name`, `short_name`, `start_url`, `display`, number of `icons`) and whether a
  service worker controls the page (`manifest.controlled`). The author's prompt now also lists `ui.advanceTime()`.
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
- 5c6c8f2: Stage 2: `qajitsu plan` (analyst + planner on any configured model, grounded sources, interactive review with
  revise/edit, open questions), `qajitsu approve` (SHA-256 freeze) and `qajitsu doctor --models`. Adds analysis and plan
  schemas (published JSON Schemas), plan versioning and diffs, the model registry (Anthropic, OpenAI, Google, Ollama,
  OpenAI-compatible) with capability profiles, the guarded agent loop with structured-output repair, token budget and
  cost journaling, and the plan source checker in the verifier.
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
- 15a7965: Stage 7: auditor, canary and model benchmark. An independent auditor agent (fresh context, by default a model other
  than the author's) reviews every PASSED case against the approved plan, raw results, text evidence and screenshots;
  its findings and the canary (one PASSED case re-run with an inverted expectation) can only move PASSED to
  NEEDS_REVIEW (`verification` section, `checks/` records protected by the guard, notes in report.html). Every planned
  expectation now needs its own `verify()`: specs that leave one out are blocked, results without it are never PASSED.
  `qajitsu bench --model <ref> [--role]` runs `.qa/bench.yaml` end to end with `--build` and reports detection, false
  FAILED, BLOCKED, plan acceptance, time, tokens and cost. `runStructuredAgent` accepts images; `ModelPorts` accepts a
  run-level model override.
- 0ecb802: Test data per case (REQ-EXEC-53): a plan case lists the records it needs in `test_data`. Before each attempt the
  runner creates them through the application's API (`test_data.kinds.<kind>.create/remove` in the project config, as
  an account alias) or the project's data hook, each marked `qj-<ticket>-<run>-<case>-a<attempt>`, gives them to the
  spec as `data.get("<name>")` and removes them afterwards in reverse order (`qj run --keep` leaves them). Data that
  cannot be created ends the attempt before any step (BLOCKED); what was created and removed is masked evidence
  (`test-data.json`); a failed removal is a journal warning. `qj data clean [<TICKET>] [--run <id>] [--all]` removes
  leftovers by marker through `test_data.cleanup` or the hook. The planner sees the project's kinds and code refuses
  others; static checks require `data.get()` to name a record of the case. `--keep` now applies to every run.
- fc55fef: Tests repository awareness: a repository with `role: tests` is checked out at its default branch on every fetch
  (marked `role: tests` in `run.json`, excluded from the deployed-version check). The planner sees an index of its
  tests and may list `existing_coverage` in the plan; every claim must name a real file and test title and real
  criteria (checked by code). The author gets the repository's selector strategy, page-object selectors and
  convention documents.
- 08e6842: The recorded traffic is read by code (REQ-EVD-09/AC1+AC2): every request of the page is tied to its step; a failed or
  blocked step lists the requests that went wrong (5xx, 4xx, timeouts, connection errors, allowlist refusals, CORS,
  redirects to login) in `steps[].network`, `S1-network.json` and next to the failure in the report, and the failure
  hints get it as structured data. Every attempt records the pages and endpoints it reached (`attempts[].requests`),
  and the report lists which case reached which endpoint of the change. Web cases can check the page's WebSocket
  messages (REQ-EXEC-47/AC3): `websocket.received.<n>` and `websocket.sent.<n>`, frames kept per step. Plan checks also
  flag a dialog without an answer, invented manifest elements, and count a changed page as covered by a web case that
  opens it. The demo shop gets a support chat over a WebSocket with BUG-17.
- 5cd2348: Failure hints (REQ-VER-12): a `triage` role suggests product bug, test bug, environment or data for each FAILED case, citing steps, assertions, evidence or logs; code keeps only real citations, hints never change a status, and they show in the matrix, report and Jira comment. `verification.triage: on|off`.
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

- 603cb14: Found in the first run with a cloud model (Claude Haiku 4.5) on the demo shop:
  
  - A planner that claims existing coverage when the run has no tests repository no longer loses the plan: each claim
    becomes an open question for the person reviewing (which test, which criteria, that no case was written), and the
    message for a wrong tests repository names the ones the run has. Claude cited the application's own tests three
    times and the plan failed.
  - The estimate before a run counts only the cases chosen with `--cases`.
- 3708575: The planner's page snapshot also records the pages the code defines when no link reaches them (an offer page no menu
  links to), so the plan sees their real texts; asset paths (`/sw.js`, `/manifest.webmanifest`) are no longer counted
  as pages. A plan whose element key lacks its selector kind (`offer-status`) gets a repair hint naming
  `testid:offer-status`.
- 47fac1e: Found by dogfooding test data with a local model (REQ-EXEC-53): a plan step that reads a record by an id the case
  never creates (`GET /products/{id}` without `test_data` or an earlier POST) is flagged and goes back to the planner
  once, then to the reviewer; a spec that does not read every record of its test data with `data.get()` goes back to
  the author instead of testing a made-up id; and a record put under `data` is refused with a message that points to
  `test_data`.
- c73286c: Releases of installable packages (REQ-GEN-15).
  
  - Every package carries its licence, notice, readme, repository, Node.js engine and public access, and ships its
    TypeScript source so source maps and stack traces point at real lines. All packages release at one version.
  - CI checks on every pull request that the packages install with npm and with pnpm and run.
  - `qj doctor` no longer asks a new project for a knowledge store plugin while its knowledge base is empty: `qj init`
    creates the folder, and only sources or an index need the store.
  - Only the CLI's own installation counts as bundled plugins: a package in a folder above it, in `NODE_PATH` or in a
    global folder is never trusted as one. Bundled plugins are found whether or not they were built.
  - The spec type check fails closed: without the steps types every spec is blocked, and a steps import that resolves
    anywhere else is refused. An installed QAJitsu checks specs against the built steps types, not the shipped sources.
  - Dependencies with known high vulnerabilities are updated: zod 4.6.6, undici 6.29.1 and 7.30.1, body-parser 2.4.0,
    follow-redirects 1.16.2.
- 39d79bd: The type check of generated specs finds the `@qajitsu/steps` types in an installed QAJitsu (REQ-EXEC-03/AC1). The
  verifier depends on `@qajitsu/steps` and resolves it, instead of assuming a sibling folder that a pnpm installation
  does not have. Before this fix, every spec in such an installation was BLOCKED with "Cannot find module
  '@qajitsu/steps'".
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
- Updated dependencies [6abb72b]
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
- Updated dependencies [3a9ffcc]
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
  - @qajitsu/steps@0.1.0
