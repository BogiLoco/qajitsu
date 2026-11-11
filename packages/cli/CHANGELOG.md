# @qajitsu/cli

## 0.1.0

### Minor Changes

- 18f9746: Failure screenshots mark the failing element (REQ-EVD-08): when a web or mobile step fails, a copy of its screenshot gets a numbered red box around each element whose assertion failed and each region that differs from the visual baseline (`<step>-annotated.png`, with `<step>-annotations.json` listing field, expected and actual value); a missing element is noted, and with a baseline the baseline copy is marked too. The original screenshot is unchanged and no status changes. `report.html`, `qj evidence --failed`, the ticket comment and `qj bug` show the annotated copy first. New `ScreenBox`/`ScreenMark` types, `regions` on image comparisons, optional `bounds` on UI drivers and `annotate` on the case runtime.
- ae9a935: Start with an API key only (REQ-LLM-09): `qj init` finds provider keys by name and proposes Claude models with a
  spending limit; Claude models have built-in context windows and prices; the run's cost adds up over every stage, an
  unknown price shows as unknown, and `budget.max_cost_usd` stops model stages; `qj doctor --models` names a rejected
  key by its variable.
- c3aea49: Snapshot of the running application (REQ-EXEC-22). Drivers list the elements a page or screen shows
  (`UiDriver.elements`, from Playwright's accessibility snapshot and test ids, or from the Appium page source). Before
  writing specs, `qj run` records each web case's pages and the app's first screen and gives the author every element
  with the selectors that find it; selectors found nowhere go back to the author once. A failed UI attempt keeps
  `failure-elements.json` for the healer, which now heals mobile cases too. `qj plan --env/--snapshot` records the
  environment's pages when the code is not available, and the plan check flags elements no recorded page shows.
- aabdb96: Mobile apps without their repository (REQ-EXEC-23): `mobile.android.app` accepts `source: file` (a local build),
  `source: url` (a download from an allowlisted host, checked against `sha256`) and `source: installed` (the app already
  on the device). The run records the app id, source, SHA-256 and version (via `aapt2` or `adb` when available) and the
  report shows them next to "Code". A download that fails or has another SHA-256 makes the mobile cases BLOCKED with the
  reason. Without code, `qj plan` also records the app's first screen for the planner (REQ-EXEC-22/AC7).
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
- 94ae770: `qj bench --knowledge on|off|compare`: `compare` runs every case without and with the project's knowledge base and reports the difference in detection, false FAILED, BLOCKED and plans accepted without edits.
- 9a6d3dc: Why a case was BLOCKED (REQ-VER-13): after the run, the triage model suggests the likely cause of every BLOCKED case
  (spec, plan, environment, tooling, configuration) with a next step, citing the error, spec lines, steps, evidence or
  logs. Code keeps only hints whose citations exist; they are printed under the result table, shown in the matrix and
  report (`checks/blocked.json`) and never change a status. Switched with `verification.triage`.
- f3cf459: Browser channels and versions (REQ-EXEC-66): `web.browser` and `web.matrix.browsers` accept `chrome`, `chrome-beta`,
  `msedge` and `msedge-beta`; `qj setup` installs the ones the matrix names (not on Linux arm64) and `qj doctor` lists
  them with the version the browser reports. Every web attempt records the exact browser and version
  (`attempts[].browser`), and the matrix, report and ticket comment name them per combination. `safari` and versioned
  entries such as `chrome@118` are accepted but run only on a device farm: without one their combinations are BLOCKED
  with the reason, never replaced by another browser, and they cannot be the primary browser. The planner also gets
  repair hints for a selector used as a `state` path and for a case without evidence.
- 7a85b02: Browser and viewport matrix (REQ-EXEC-13): `web.matrix` runs web cases in every browser × viewport combination with results and evidence per combination; `combineStatuses` makes a case PASSED only when every combination passed; a missing browser is BLOCKED with the install command; matrix, report and Jira comment show the status per combination.
- 71f8b88: `qj bug <TICKET>`: reports FAILED cases as Jira bugs after showing similar open bugs; the report is rendered by code from the run (steps, expected vs actual, version, environment, evidence by hash, hint), masked, labelled `qajitsu` and linked to the tested ticket, or the failure is linked to an existing bug. New `BugTracker` interface with Jira (Cloud, Data Center) and file implementations.
- f431a44: Exploratory sessions of command-line tools (REQ-EXEC-24): `qj explore <ticket> --cli <tool>` lets the explorer use any
  tool described in `explore.cli` (QAJitsu's own `qj` in the demo shop) in a throwaway sandbox with its own HOME, only
  the configured variables, an allowlist proxy and argument arrays; every command's exit code, output and changed files
  are recorded with SHA-256, leftover processes and containers are found and stopped, and `qj explore promote` writes a
  regression test proposal for an observation.
- b85692f: Command-line exploratory sessions can be watched live (REQ-EXEC-24/AC9-AC11): one line per action, every rejected
  answer and observation as they happen; `--headed` shows every command with its output as it arrives, typed answers,
  Ctrl+C and background output; `--slow-mo <ms>` paces it. The terminal is recorded as
  `evidence/recordings/terminal.cast` (asciicast v2) and `terminal.txt`, in the manifest, with the transcript in
  `report.html`. `qj logs --follow` keeps following while another `qj` process holds the run, e.g. an exploratory
  session (REQ-OBS-02/AC3).
- fb25279: `qj test <TICKET>` runs the whole flow in one command (fetch, plan with review, run, publish after the preview;
  `--dry-run` stops before publishing). `qj env up <TICKET>` starts the application from a run's worktree without
  agents or tests (`--detach` for containers). Every command, option and exit code is listed in `docs/cli/commands.md`.
- 8125f74: `code: { access: full | metadata | none }` (REQ-CTX-10): a project can keep its code from QAJitsu. With `metadata`
  only the PR/MR title, description and changed file names are kept; with `none` nothing is read from the code hosts.
  Agents are told, `--build` says it needs the code, and the report header and `qj fetch` say what was shared.
- 8384943: Context metrics and policies (REQ-CTX-18): `qj metrics` exports per role and model the estimated input tokens by
  fragment kind, reductions by action, assembled inputs, `read_context` and `search_context` calls and the prompt cache
  hit rate (`contextUsage` / `mergeContextUsage` in `@qajitsu/report`). `qj bench --context <policies>` runs every case
  once per context policy (`default`, `full`, `compact`, `range=<tokens>`, combined with `+`), reports detection, plan
  quality, tokens, cost and time per policy and names the cheapest policy that keeps the best quality. The model
  registry takes a `contextPolicy` that wins over every model's own working range and style.
- de56650: Model inputs rebuilt from their snapshots (REQ-CTX-17/AC4): every model call keeps the texts of the fragments it
  showed in the run, by hash (`context/fragments/<sha256>.txt`). `qj audit verify` rebuilds each call's input from its
  `context.snapshot` (trimming applied again by code, rendered with the run's marker) and names every fragment that
  changed or is missing; `qj reproduce` reports the same for the certified run before running it again. Runs from
  before this change are skipped. `renderFragments` and `rebuildCall` are exported from `@qajitsu/agents`.
- ac46226: Test depth, estimate and budget (REQ-PLAN-08): `qj plan --depth smoke|standard|full` keeps cases by risk (priority) and records the depth and why each case is in or out; every run starts with an estimate of execution time and model use from the project's past runs; `budget: { max_minutes, max_cost_usd }` makes the remaining cases NOT_RUN with the reason. plan.md also shows manual steps, messages, visual checks and locales.
- 7de9efc: Environment readiness for the ticket (REQ-ENV-13): `environments.readiness` lists where each repository's deployed
  commit is read (a JSON endpoint: a version endpoint, the deployments API of GitHub or GitLab, Argo CD; or a script of
  `.qa/hooks/`) and the checks before the first case (HTTP status and JSON values for health, migrations and feature
  flags, limited to ticket labels where needed; account logins; scripts). The deployed commit must be the change or
  contain it, checked in the run's worktree. Not ready: every case is BLOCKED with the failed checks and their observed
  values, after waiting for the deployment when `wait` is set. `qj run --env-not-confirmed "<reason>"` runs anyway:
  results are marked "environment not confirmed" and `qj release` never counts them as verified. The report goes to
  `run.json`, `report.html`, the Jira comment, the certificate and, per `comment`, a ticket comment. In pull mode a
  ticket is parked in its start status until its environment is ready.
- c268171: Exploratory sessions: `qj explore <TICKET> --goal "..." [--time-box <min>] [--max-steps <n>]` lets the new `explorer`
  agent explore the application through browser actions QAJitsu performs and records (screenshots, video, trace,
  network, console in the evidence manifest). Observations cite the recorded actions as steps to reproduce; the session
  writes `explore/<session>/report.html` and `report.md` for review and never produces statuses. `qj explore promote`
  turns an observation into a draft plan case with a new `observation` source kind; it runs only after approval.
  `explore/` is protected from agent writes.
- 693612b: Every explorer (browser and command line) must act before it summarises: a summary while the session has no recorded
  action is rejected with the tools still available, and a session whose agent never acts ends with `error` and an
  empty summary (REQ-EXEC-15/AC8, REQ-EXEC-24/AC8). Ollama models accept `think: true|false` in their capabilities,
  passed to Ollama, because thinking models such as Qwen3 call tools only when it is set.
- b17d302: Exploration before planning (REQ-PLAN-11): `qj explore review` lets a person accept or reject what exploratory
  sessions found (observations, findings, not-done checklist items), keep accepted ones in the knowledge base with
  `--keep`, and `qj plan` offers the planner only the accepted items. Cases may cite them as `{kind: explore}`; code
  refuses items not accepted, turns cases with no source for their expected result into open questions, and lists
  accepted not-done items no case covers.
- 1b0fc13: Exploratory sessions report a checklist and findings that code checks against the recorded actions (REQ-EXEC-25).
  `qj explore --check "<item>"` (repeatable) gives the goal's checklist; every item ends up done with its actions or not
  done with the reason, never silently dropped. Invented action ids and, for command-line tools, flags that no command
  ran are refused, items left undone are sent back once while the step budget lasts, and refused answers are journaled
  (`explore.answer_rejected`). `session.json` gains `checklist` and `findings`; the report shows them before the
  explorer's comment, and the terminal says how many items were done. The explorer's answer is now
  `{checklist, findings, summary}` instead of `{summary}`.
  
  In command-line sessions an item naming a subcommand ("qj doctor") must cite an action that ran it, and an item whose
  command ran cannot be reported as not done because the command failed: its error is the result.
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
- 95cbe71: `qj init` installs the official plugins the new project's configuration needs (REQ-GEN-11/AC1), such as the Jira
  plugins for a Jira project, so the usual flow needs no extra step. A plugin that cannot be installed makes the project
  NOT READY, with the reason.
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
- d01e14f: Optional Chroma knowledge store (`knowledge.store: chroma` with `knowledge.chroma.url` and `token` as secret:// references): one collection per project on a shared server, over Chroma's HTTP API without a client dependency; https required except on localhost.
- d5a352c: `qj knowledge add|sync|remove|reset|reindex|list|search`: a per-project knowledge base with incremental sync by content hash, full or hybrid retrieval by size, embedding model checks, masking of secrets (including test account passwords from environment profiles) and a one-time confirmation for cloud embedding models. `qj status` shows its sources, mode and last sync.
- 1d4802f: Online knowledge sources: `qj knowledge add confluence:<SPACE>[/<page>]` (Cloud and Data Center) and `jira:bugs[/<component>]` (resolved bugs tagged by component), synced incrementally by page version or issue update time through the new `DocumentSource` interface.
- 248cbe1: PDF documents with a text layer are added to the knowledge base page by page (scans are skipped with the reason). The LanceDB store selects its score columns explicitly; a scale benchmark (`bench/knowledge-scale.mjs`) measures search on 1 million chunks.
- e27cccf: Run one case with a live view (REQ-EXEC-16): `qj run --cases TC-02` runs only the chosen cases of the approved plan (the others are NOT_RUN, "not selected"); `--headed` shows the browser or the emulator window and `--slow-mo <ms>` slows browser actions; `--step` pauses before every step in the trusted parent, with the case's time limit standing still, and a stop leaves the case BLOCKED in every retry. New optional `pause` on `AttemptRequest` (`StepPause`, `PausedStep`) and `slowMoMs` on the web runner.
- 2d298c8: Live progress of a run (REQ-OBS-09): `qj run` prints each case start with a counter, each step and each attempt outcome as plain lines; the runner journals `step.start` as steps begin. `qj watch <TICKET>` serves a page on 127.0.0.1 with the cases, the step running now, the latest screenshot (`<run>/live/`, not evidence) and preliminary outcomes, then the computed statuses; a run that stopped is shown as stopped. New optional `progress` on `AttemptRequest` (`AttemptProgress`) and `onScreenshot` on the case runtime; the guard protects `live/`.
- dcca1a0: Locale runs (REQ-EXEC-14): project `locales` with time zones; plan cases list their locales and give per-locale expected values (`expect.by_locale`, only planned keys); each locale runs with the plan resolved for it (`planForLocale`), the browser locale and time zone and an `Accept-Language` header; the case is PASSED only if every locale passed; reports show the status per locale.
- 3c66a3b: Manual steps (REQ-EXEC-11, ADR-0008): plan steps can be `manual: true` with instructions; the run asks a tester in the terminal or waits for `qj answer` in CI; the answer is an assertion with `source: manual`, who and when, plus evidence; failed → FAILED, no answer → BLOCKED; reports name who performed each manual step; agents cannot answer (guard). `manual.timeout_s`.
- 112d074: Map as planner input (REQ-OBS-08): `qj plan` builds the application map of every past run and stores the part around the change in `map/around.json` (touched screens and endpoints, never tested ones next to them, transitions from or to them). The planner sees it as untrusted data and may add regression cases citing `{kind: map, id}`, checked by code; the guard protects `map/`. New `mapAroundChange` in the report package and `collectAppMap` behind `qj map`.
- 8424bf7: `qajitsu map` aggregates the transition graphs of every run into an application map (`map.json`, `map.html`) with
  tested and never-tested screens and API operations (REQ-OBS-07). The Claude Code plugin in `plugin/` (marketplace in
  `.claude-plugin/`) adds `/qa-plan`, `/qa-run` and `/qa-evidence` for chat-driven use, with approval always left to the
  user (REQ-GEN-04). `ops/grafana` is a local OpenTelemetry Collector, Tempo, Loki, Prometheus and Grafana stack with the
  QAJitsu overview dashboard (REQ-OBS-04/AC3).
- b13168a: The author can explore the application through MCP servers (`mcp.servers`, e.g. Playwright MCP) to find selectors.
  Servers start without a shell, with a minimal environment, in a temporary folder outside the run; only the listed
  tools are offered, every call goes through the guard and the journal, `url` inputs are checked against the
  environment allowlist, images are not stored, and exploration never produces results or evidence. New dependency:
  `@ai-sdk/mcp` (the AI SDK's MCP client, already part of the stack).
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
- 83fcb63: Numbers written as text in plan expectations (`total: "1.01"`) are converted by code when the OpenAPI document says
  the field is a number or an integer; `qj plan` lists every conversion and the planner is not sent back for them
  (REQ-PLAN-12).
- 8a03150: Onboarding through `.qa/` only: login scripts in `.qa/auth/` (`login: { script: auth/<file> }`) for form, cookie
  or SSO logins, and `hooks.setup` / `hooks.teardown` around every run (a failing setup makes every case BLOCKED).
  `mobile.devices` runs mobile cases on several emulators or farm sessions in parallel, one case at a time per
  device. Publishers honour an aborted signal before sending anything. `qj run` lists every configuration problem.
- 4505978: OpenAI and Gemini models have built-in context windows and prices, and `qj init` proposes their models for an
  OpenAI or Gemini key like for an Anthropic one (REQ-LLM-09/AC6). Prices announced to rise stop being used after the
  day they rise: the cost then shows as unknown rather than too low.
- adb1475: API, web and mobile cases run at the same time in lanes (`execution.workers.api|web`, `execution.web_combinations`
  for several browsers of the matrix at once); `qj run --sequential` or `execution.sequential: true` runs one case after
  another. Mobile cases can use several different devices (`mobile.android.emulators` with hardware profiles,
  `mobile.ios.farm.devices`) that split the cases or each run all of them (`mobile.distribute: matrix`, status per
  device in the reports). Test account aliases can be pools (`pool:`, `lanes:`, `shared:`): each running case holds its
  own accounts, waits for a free one up to `execution.account_wait_s`, and the journal names the pool member, never the
  user name; `qj env check` warns about pools that are too small. `qj setup` installs every system image and AVD and
  counts all emulators in its memory check. `runCases` passes a login context (case, attempt, spec, lane) and releases
  the attempt's accounts when it ends.
- 24d21c4: Passive observations (REQ-EVD-07): web runs record browser console errors, 4xx/5xx responses and axe-core WCAG A/AA
  violations of every visited page in `observations.json`; with OpenAPI contract mismatches they are listed in their
  own section of `report.html` and the Jira comment and never change a status or a count. Configure under
  `observations:` (switch checks off, ignore entries). New dependency: `axe-core` (MPL-2.0).
- 7001904: `qj plan --build` starts the environment from the run's worktree and the mobile devices only to record the pages and
  the app's first screen for the planner, then stops them (REQ-EXEC-22/AC9), so plans of applications built per run
  expect the texts the application really shows.
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
- 3ec9d51: The guard holds every plugin to its manifest (REQ-GEN-11/AC4+AC9, ADR-0015). `@qajitsu/guard` adds
  `checkPluginCode`. At install, and again before an installed plugin is loaded, the plugin's own code is checked
  against its permissions: Node's network, process and file modules, reads of `process.env` and the global `fetch`. A
  plugin that does more than it declares, or that refers to the frozen plan, is refused. Every HTTP call of an
  integration plugin goes through a guarded `fetch` that allows only its manifest's hosts and the URLs the project
  configures for it. Plugin manifests get the `environment` permission, and five manifests that understated their code
  are corrected.
- 9876a31: LanceDB, the default knowledge store, is no longer part of the CLI installation (REQ-GEN-11/AC1). It is installed
  with `qj plugin add knowledge-lancedb`, or by `qj setup` for a project with a knowledge base. This takes the
  published CLI from 389 MB to 141 MB. The adapter takes `@qajitsu/core` as a peer dependency. Plugin manifests can
  list `omit_optional`: optional dependencies the plugin never loads, which are installed as empty packages. LanceDB
  uses it for its own embedding helpers, so the installed plugin is 245 MB instead of 607 MB. A plugin's manifest is
  read from its tarball and checked before npm runs.
- a14a753: A plugin can need other plugins (REQ-GEN-11/AC3). It declares them as `@qajitsu/adapter-*` peer dependencies.
  `qj plugin add`, `qj setup` and `qj doctor --fix` install them along with it, and the loader links them, from this
  installation or its installed plugins, before the plugin loads. A missing one is named with its install command. Every
  other QAJitsu package is removed from a plugin's folder, so plugins always share the installation's copies.
- 1384f6e: Plugins installed on demand (REQ-GEN-11). `@qajitsu/core` adds `PLUGIN_API_VERSION`, `PLUGIN_TYPES`,
  `parsePluginManifest` and `PluginError`. Every adapter package now carries its plugin manifest under
  `qajitsu.plugin`. The CLI adds `qj plugin list|add|remove`, which installs the version a release pins from the npm
  registry, checked against its published checksum and without install scripts. `qj doctor` names missing plugins and
  `--fix` installs them, `qj setup` installs the plugins a project needs, runs record the plugin versions they used,
  and `qj knowledge` loads its stores and sources through the plugin loader.
- 35b9297: Offline installations get their plugins from the bundle (REQ-GEN-11/AC6). `qj setup --download <dir>` installs the
  plugins the project needs, with their dependencies and checked against their published checksums, into
  `<dir>/plugins/`. `qj setup --from <dir>` copies them into the QAJitsu home without any network, after checking each
  manifest and core API range again.
- 016c6f1: Start fresh and clean up per project: `qj work reset <TICKET> [--delete]`, `qj clean --project [--dry-run]` (retention plus stale git mirrors), `qj projects remove <slug>` (confirmation, `--dry-run` with sizes, `.qa/` kept, journals archived) and `qj projects archive|unarchive <slug>`.
- a22d313: `qj projects export <slug>` and `qj projects import <file>`: move a project to another machine with its `.qa/` files and knowledge sources (never secrets, the index or runs; exports with a secret value are refused). Credential masking now leaves references alone (`secret://`, `{{template}}`, `${VAR}`, `process.env.X`).
- 725180c: `qj status [--all]` shows readiness, default environment, knowledge base and each open ticket with its state and next
  command; `qj note` attaches notes; `qj resume` without a ticket lists resumable work, and a run whose environment or
  secrets changed after approval asks for confirmation (`RUN_CONTEXT_CHANGED` in CI). The evidence zip and `qj export`
  default to the project's `exports/`; `qj evidence --serve` serves a run's report and evidence on localhost.
- df9aa5c: Projects (ADR-0006): `qj init <slug>` registers a project in `~/.qajitsu/projects/<slug>/` (runs, git cache, knowledge,
  exports, logs) and links or creates its `.qa/`; `qj use`, `qj projects list|current` switch between projects. Every
  command resolves its project from `--project`, `QAJITSU_PROJECT`, the ticket prefix or the active project (never the
  current folder), names it on its first output line and records it in `run.json`; a run is only continued in its
  project. Run folders and git mirrors default to the project home. The guard denies reads outside the run workspace.
  CI registers the checked-out `.qa/` in a temporary home.
- ea69cf8: `qj promote <TICKET>`: proposes the run's PASSED cases as a pull/merge request to the tests repository with the exact specs that passed and the approved plan's expectations, after a confirmation. Runners record each attempt's spec SHA-256 (results and journal); `CodeHost.openChangeRequest` for GitHub and GitLab; `repos.<alias>.promote_dir`.
- 254a8c8: Shared environments (REQ-EXEC-54). `execution.rate_limit` limits the requests per second to one host and the cases at
  once, across every lane of a run. A `429` or `503` with `Retry-After` is waited out and retried, only for a request
  that is safe to repeat: a GET, or a request of a plan step with `idempotency_key: true`, which also carries an
  `Idempotency-Key` that stays the same on retries. Every retry is evidence. A case still rate limited after its budget
  is BLOCKED as "rate limited", never FAILED or PASSED.
- a1c68c5: Regression runs of promoted packs (REQ-EXEC-17): `qj regression [--env] [--packs] [--from] [--ref] [--publish]` runs every pack `qj promote` put in the tests repository again as a run of its ticket, with the sandboxed runners and no agent or model (no authoring, healing, auditor or triage). Specs and expected values are checked against the pack's hashes; a mismatch makes the case BLOCKED. The suite report (`regression.md`, `report.html`, `junit.xml`) lists regressions. `qj promote` now records `cases_sha256` in `expectations.yaml`.
- 6fb3db3: Release readiness report (REQ-PUB-09): `qj release <fixVersion>` (or `--sprint <name>`) collects every ticket of the release from Jira (JQL on the project's fix version or sprint) or the file source (`fixVersions`, `sprint`), evaluates each ticket's latest executed run with the same code as `qj publish` and writes `exports/releases/<name>.md`: status counts, open cases, tickets without a run (never ready) and runs whose gates fail (untrusted). `--publish <KEY>` posts it as a comment after a preview. `TicketSource.findTickets` is a new optional method.
- e998bfd: `qj runs <TICKET> --keep <id>` and `--unkeep <id>`: mark a run (and its evidence) as exempt from retention in `gc`, `clean --project` and `work reset --delete`, or release it again.
- 6f00289: Secret managers besides `env` under `secrets:` in `qa.project.yaml`: HashiCorp Vault KV v2 (`secret://vault/<path>#<field>`),
  Doppler (`secret://doppler/<NAME>`), 1Password, AWS Secrets Manager and Google Secret Manager through their CLIs
  (`secret://op/...`, `secret://aws/...`, `secret://gcp/...`). Their own tokens come from `secret://env/...`. `pnpm demo`
  runs the whole flow on the demo-shop offline; CI reviews new dependencies and audits the installed tree.
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
- 5c6c8f2: Stage 1: `qajitsu fetch <TICKET>` creates a run folder with the ticket snapshot, discovered PRs/MRs/branches, diffs,
  review comments and git worktrees at the exact SHA. Adds Jira Cloud and file ticket sources, GitHub (incl. GHES and
  GitHub App), GitLab (incl. self-managed) and local code hosts, the `env` secret provider, the run event log and masked
  arguments in the guard journal. `createJournal` now requires a masking function.
- cbd6fbb: Stage 10: CI/CD. `qajitsu ci detect` finds the trigger (labelled PR/MR with the ticket key in branch or title, `/qa
  approve` and `/qa revise` comments from people with write access, manual runs, Jira automation dispatches) and
  writes GitHub outputs; `qajitsu ci publish-plan` posts the plan to Jira; `qajitsu ci comment` keeps one updatable
  PR/MR comment and sets the `qajitsu/<TICKET>` status check (`upsertComment`, `setCommitStatus` on GitHub and
  GitLab). `qajitsu approve --approver` records who approved in CI and `--reuse-from <run|latest>` reuses an approved
  plan only when the ticket is unchanged. Every report now includes `junit.xml`; `qajitsu export` writes the pipeline
  artifacts. `QAJITSU_WORKSPACE` overrides the workspace root. Ready-made integrations: GitHub Action and workflow,
  GitLab CI template, Docker image and Jenkinsfile in `ci/`. REQ-EXEC-05/AC1 reworded to match ADR-0004; the demo
  model now uses its full 128k context.
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
- b447614: Stage 4: `qajitsu publish` recomputes statuses and gates from disk, shows a preview, then posts the results comment
  (ADF on Jira Cloud, wiki markup on Data Center) with the evidence zip and updates the same comment when a run is
  published again. Adds `qajitsu evidence` for local reproduction, the Jira Data Center ticket source and the
  `publish` configuration section. The `Publisher` interface now takes a rendered comment and returns a result with
  uploaded and skipped attachments.
- 76edd93: Stage 5: web and mixed tests. The trusted parent drives a Playwright browser for sandboxed specs (ADR-0004) with a
  screenshot per step, full-page screenshot, DOM, video and trace on failure, HAR and console per case; `ui.*` in the
  steps API and `elements`/`texts` expectations in plans; the healer limited to selectors and waits by an AST diff
  (healed passes are NEEDS_REVIEW); parallel workers; `qajitsu logs`, a timeline and a transition graph in report.html;
  `qajitsu evidence` opens the report, videos and traces; `qajitsu pull` downloads CI evidence from Jira; ffmpeg video
  compression before upload. `CaseRuntime.endStep`, `verify` and `finish` are now async.
- ef6861b: Stage 6: local environments, configuration and cleanup. `qajitsu run --build` starts the application from the
  run's worktree: Docker Compose with a generated overlay (project `qj-<ticket>-<suffix>`, dynamic localhost ports,
  `qajitsu.*` labels on containers, networks and volumes), managed processes with logs, WireMock/Mockoon stubs listed
  in the report, health checks and a seed hook with the run marker. Service variables are constants, templates
  (`{{svc.db.url}}`, `{{port}}`) or secret references, with `--set` overrides for overridable ones; per-service `.env`
  files are 0600 and deleted on every exit path. The configuration is validated before start (`qajitsu env check`,
  exit code 3), the masked effective configuration is recorded in `run.json`, and a start failure makes every case
  BLOCKED with the service logs as evidence. New commands: `env check`, `env render`, `runs`, `resume`, `clean`, `gc`;
  cleanup policy and retention (`cleanup` section, `--keep`); run lock files and a locked run index.
- 15a7965: Stage 7: auditor, canary and model benchmark. An independent auditor agent (fresh context, by default a model other
  than the author's) reviews every PASSED case against the approved plan, raw results, text evidence and screenshots;
  its findings and the canary (one PASSED case re-run with an inverted expectation) can only move PASSED to
  NEEDS_REVIEW (`verification` section, `checks/` records protected by the guard, notes in report.html). Every planned
  expectation now needs its own `verify()`: specs that leave one out are blocked, results without it are never PASSED.
  `qajitsu bench --model <ref> [--role]` runs `.qa/bench.yaml` end to end with `--build` and reports detection, false
  FAILED, BLOCKED, plan acceptance, time, tokens and cost. `runStructuredAgent` accepts images; `ModelPorts` accepts a
  run-level model override.
- ee9111a: Stage 8: mobile. `@qajitsu/adapter-runner-mobile` drives Android (UiAutomator2) and iOS (XCUITest, device farms) apps
  through Appium with WebdriverIO from the trusted parent; specs use the same `ui.*` API plus `ui.back()`. QAJitsu
  starts and stops the Android emulator and the Appium server, takes the app from CI artifacts of the change SHA
  (`downloadArtifact` for GitHub Actions and GitLab CI), a worktree file or a build command, runs mobile cases
  sequentially on the device, and records a screenshot per step, the screen recording, logcat/syslog and the page
  source on failure. Unavailable platforms (iOS without Xcode or a farm) make cases BLOCKED with the reason. New
  `mobile` config section; `UiDriver` gains `back()`.
- b5b577c: Stage 9: generalization and operations. `qajitsu init` creates `.qa/` for any repository (git host from the remote,
  compose services and ports, OpenAPI document, web/mobile test types) and validates it; `qajitsu doctor` checks secrets
  by reference, Docker, Android SDK and Appium, iOS availability and, with `--online`, Jira and code host access
  (`check()` on ticket sources and code hosts). Runs export OpenTelemetry traces (run = trace, stage = span, tool/model
  calls and case attempts = child spans), logs and metrics over OTLP/HTTP (`telemetry` section, `qajitsu telemetry
  export`). `qajitsu metrics` aggregates runs for Prometheus with example alert rules. The run journal is a SHA-256 hash
  chain (`qajitsu audit verify`, `journal-intact` publish gate) and `gc` archives journals under `audit.retention_days`.
  `pnpm docs` builds the TypeDoc site; CI runs on Linux and macOS.
- 0ecb802: Test data per case (REQ-EXEC-53): a plan case lists the records it needs in `test_data`. Before each attempt the
  runner creates them through the application's API (`test_data.kinds.<kind>.create/remove` in the project config, as
  an account alias) or the project's data hook, each marked `qj-<ticket>-<run>-<case>-a<attempt>`, gives them to the
  spec as `data.get("<name>")` and removes them afterwards in reverse order (`qj run --keep` leaves them). Data that
  cannot be created ends the attempt before any step (BLOCKED); what was created and removed is masked evidence
  (`test-data.json`); a failed removal is a journal warning. `qj data clean [<TICKET>] [--run <id>] [--all]` removes
  leftovers by marker through `test_data.cleanup` or the hook. The planner sees the project's kinds and code refuses
  others; static checks require `data.get()` to name a record of the case. `--keep` now applies to every run.
- b520f06: `qj setup` installs what a project needs (Playwright browsers, Docker through Colima or Docker Engine, Eclipse Temurin
  Java, the Android SDK with emulator, system image and AVD, Appium with UiAutomator2/XCUITest, Xcode through xcodes) at
  pinned versions into `~/.qajitsu/toolchain/`, with prechecks, resumable checksum-verified downloads, licence
  confirmation or `--yes`, smoke tests, `--check`/`--json`, `--only`/`--skip`, `--reinstall`, `--uninstall [--all]`,
  `--version tool=version`, offline bundles (`--download`/`--from`) and private mirrors, proxy and company CA in
  `toolchain.yaml`. Compatible tools already on the machine are used as they are and incompatible ones are never changed.
  `qj doctor` shows the toolchain plan, `--fix` runs setup, `--online` checks the sources. The emulator starts with
  `-no-metrics` and accepts an AVD folder (`avdHome`).
  
  CI: the GitHub Action (input `setup`) and the GitLab template (`QA_SETUP`) run `qj setup` and cache
  `~/.qajitsu/toolchain/` by QAJitsu's pinned versions and `.qa/toolchain.yaml`; `ci/docker/Dockerfile.android` builds
  an image with the Android tools for KVM hosts. `qj setup --ignore-check <check>` lets an image build skip the
  virtualisation precheck.
- 5cd2348: Failure hints (REQ-VER-12): a `triage` role suggests product bug, test bug, environment or data for each FAILED case, citing steps, assertions, evidence or logs; code keeps only real citations, hints never change a status, and they show in the matrix, report and Jira comment. `verification.triage: on|off`.
- 3c97959: Versions (REQ-GEN-03/AC4+AC5, REQ-OBS-10): `qj doctor` ends with the versions of QAJitsu, the system, Node.js, git, Docker and Compose, Playwright and each browser, Java, the Android SDK, emulator, Appium and its drivers (missing tools the project needs are errors with the install command) and of the application under test (git mirror, default branch and latest run per repository; with `--online` the remote and the version deployed on each environment; where the mobile binary comes from). Every run records the tool and model versions it used in `run.json`; `report.html`, the ticket comment, `qj runs` and `qj evidence` show them; `qj promote` keeps them in the pack, and `qj regression` and `qj run --fix-check` list the versions that differ.
- 24308e8: Visual regression (REQ-EXEC-12): `expect.visual` compares a step's screenshot (masked regions) with the baseline in `.qa/baselines/` per browser, viewport and locale; above the threshold → FAILED with baseline, screenshot and diff; no baseline → NEEDS_REVIEW (`review` assertions never PASS) with the screenshot proposed; `qj baseline accept` (manifest-checked) is the only way baselines change. New dependencies in runner-web: pngjs 7 (MIT), pixelmatch 8 (ISC).
- c2d6ffe: Web cases can upload and download files (checked by name, type, size, hash and CSV/JSON/XLSX/PDF content), work
  inside iframes, pop-ups and new tabs, hover, double and right click, drag and drop, press keys, scroll infinite lists,
  reach into Shadow DOM, check canvas content through the application's test hook or an element screenshot, answer
  browser dialogs, run at a planned time and move it, use browser permissions and a location, and reach staging behind
  HTTP authentication. The assertion lock now also compares actions and control flow, so a healer cannot change what a
  test does.

### Patch Changes

- 322dcb3: New core package `@qajitsu/adapter-files` (REQ-GEN-11/AC1). It holds the adapters that work from local files: tickets
  and their workflow, the publisher and bug tracker that write files, resolved bugs for the knowledge base, and manual
  cases from CSV or Excel. They moved out of `ticket-jira`, `publish-jira` and `testcases`, which no longer export them,
  so those packages can become plugins while a project on files keeps working without any plugin. `@qajitsu/core` now
  exports the helpers these adapters share: `bugMarkdown`, `componentTag`, `toImportedCase` and `MAX_IMPORTED_CASES`.
- 603cb14: Found in the first run with a cloud model (Claude Haiku 4.5) on the demo shop:
  
  - A planner that claims existing coverage when the run has no tests repository no longer loses the plan: each claim
    becomes an open question for the person reviewing (which test, which criteria, that no case was written), and the
    message for a wrong tests repository names the ones the run has. Claude cited the application's own tests three
    times and the plan failed.
  - The estimate before a run counts only the cases chosen with `--cases`.
- 6da421c: Selectors for any web or mobile application (REQ-EXEC-21): `web.test_id_attribute` (e.g. `data-qa`) for `testid:`,
  the element inventory and snapshots; new selector kinds `placeholder:`, `alt:`, `title:`, `id:` (web) and `id:`,
  `xpath:` (native apps); on Android `testid:` also finds the resource id. The inventory finds Android `@+id`, SwiftUI
  `.accessibilityIdentifier`, Flutter `Semantics(identifier:)`, `Key` and `ValueKey`. Static checks accept only the
  kinds of the case's platform and flag `xpath:` for review. Prompts list selector kinds by stability and no longer use
  demo-shop ids. A screen without any addressable element makes the case BLOCKED with that reason.
- 4a252ab: The adapters of a project are built through the plugin loader (REQ-GEN-11/AC2): the Jira ticket source, the GitHub and
  GitLab code hosts and the Xray, Zephyr and TestRail case sources each come from their plugin, and a missing one stops
  the command with the command that installs it.
- 016d940: Waiting for asynchronous outcomes (REQ-EXEC-46): a plan step may set `wait: { timeout_s, interval_s }`. The runtime,
  in process and in the sandbox, repeats the step's actions and checks until every planned expectation of the step
  holds or the time is up; the interval does not count against the case's time limit. Every round is evidence
  (`<step>-wait.json`), the attempt records `wait: { waitedMs, rounds, met }` per step and `report.html` shows it; a
  check not met in time fails with the last observed value, and a round that leaves out a planned check never counts as
  met. The planner prompt and the plan review show the wait. The demo shop's documents are processed for two seconds
  (BUG-22: never ready).
- e6bc0fd: Command-line exploratory sessions after the security and code review: Ctrl+C or SIGTERM stops the session and still
  cleans up everything it started and removes the sandbox; the time box stops a running command and queued ones never
  start; output of background commands is masked as a whole so a secret printed across two reads stays masked; the live
  view keeps background lines whole, masks multi-line secrets line by line, and strips terminal escape sequences from
  everything shown or recorded; more argument forms that name paths outside the sandbox are refused (`-o/x`, `--out:/x`,
  `@/x`, `file:` URLs, links out of the sandbox); `.env*` and `.qa-runs` of a fixture are never copied or read; the proxy
  drops hop-by-hop and `Proxy-Authorization` headers; `explore.cli.<tool>.allowlist` takes http(s) origins only; agent
  text in `report.md` cannot form links or images. The explorer's checklist check accepts `qj doctor` in backticks or
  quotes, ignores prose such as "qj prints help", and refuses items of `--check` swapped in the answer.
- 36a1b10: The tests-repository index is cached per project by `<repo>@<sha>` in `<project-home>/cache/index/` and reused by later runs on the same commit; corrupt entries are rebuilt, and `qj clean --project` removes entries unused for `cleanup.max_age_days`.
- 114a668: Fixes from the exploratory pass over every command (REQ-NFR-09): `qj export` says what its exit code means,
  `qj regression` no longer estimates models it does not use, `qj init` names the right next step after choosing
  models, `qj projects remove` lists an exported profile it deletes, and `qj knowledge search` and `qj note` take
  unquoted words.
- a3ab148: Context budgets (REQ-LLM-15, REQ-CTX-12, REQ-CTX-14): every model has a context profile (working range below the
  window, answer reserve, token margin per family, provider counting for Anthropic, cache style, compact style for small
  windows and local models; `working_range` and `context_style` per model in `models.providers`). Calls that fit are
  sent as they are; otherwise the context manager reduces by code: on-demand material and what matches nothing of the
  task go behind handles, large diffs and logs are trimmed with their structure kept, then the least relevant fragments
  follow; pinned fragments are never touched and a call they alone overflow is refused. Agents read handles with
  `read_context` and find them with `search_context`; reads are journaled. Snapshots carry the budget, the catalogue and
  the relevance ranking; `qj logs` shows them in one line. Tool results are wrapped in the run's data blocks.
- e387a21: Large changes and semantic signals (REQ-CTX-19, REQ-CTX-20): a change too large for the analyst's budget is split by
  code per repository and per group of related files (a module with its tests), each part analysed in its own call;
  code merges the parts (duplicates removed, sources joined, questions renumbered) and checks every source again. The
  split, the parts and their snapshots are journaled and kept in `analysis.parts.json`; the planner of a split change
  gets the diffs behind handles. With a local embedding model from the project's hybrid knowledge index, similarity to
  the task is a second ranking signal, near-identical fragments confirmed by code are sent once, `search_context`
  also searches by meaning, and a lone file can join the group it resembles; vectors are cached by hash and model and
  the model is named in the snapshot. Without one, or when it fails, the code's signals alone decide. Lessons of
  earlier runs (false FAILED from `qj feedback`, escaped defects, revisions people asked for) reach the analyst and
  planner as low-priority data fragments (`collectLessons` in `@qajitsu/core`).
- 20ae077: Summaries as the last resort (REQ-CTX-14/AC5, REQ-CTX-17/AC2): when the budget leaves fragments out of a call whose
  model cannot read handles, the `summary` model shortens them (non-pinned only, the largest four at most), keeping
  numbers, identifiers and quoted expectations; the full text stays behind a handle and the reduction names the model.
  Summaries are cached in the run by input hash, model and prompt version, so a repeated run reuses them; a failed
  summary leaves the fragment behind its handle and is journaled. `models.context_summaries`: `no-tools` (default),
  `allowed` or `off`.
- 730f710: Logins for real web applications (REQ-EXEC-67): the HTTP login can use the `Set-Cookie` of its response as the
  session (no `token_path`), login scripts can print `cookies` or a Playwright `storage_state`, and `web_session:
  { storage: cookies }` makes `ui.as(alias)` load them for the application's origin only. `ui.fillSecret(selector, alias,
  "password" | "username")` types an account's secret into a login form: the runner resolves it, screenshots black the
  field out, and specs, agents, evidence and the journal see only the mask. Traces kept as evidence are now masked,
  including sensitive headers and cookies the application set during the test. `zip`/`unzip` moved to
  `@qajitsu/core` (still exported by `@qajitsu/report`). Demo shop: sign-in with an HttpOnly cookie and BUG-18 (DEMO-13).
- b587262: `qj doctor` reports a missing tool once (the Android SDK covers its emulator, Appium its drivers, Docker Compose),
  warns when `.env.local` can be read by other users of the machine (`chmod 600`), and `qj doctor --models` checks only
  the models, including the approval flow's model (REQ-GEN-08).
- 3708575: The planner's page snapshot also records the pages the code defines when no link reaches them (an offer page no menu
  links to), so the plan sees their real texts; asset paths (`/sw.js`, `/manifest.webmanifest`) are no longer counted
  as pages. A plan whose element key lacks its selector kind (`offer-status`) gets a repair hint naming
  `testid:offer-status`.
- 47fac1e: Found by dogfooding test data with a local model (REQ-EXEC-53): a plan step that reads a record by an id the case
  never creates (`GET /products/{id}` without `test_data` or an earlier POST) is flagged and goes back to the planner
  once, then to the reviewer; a spec that does not read every record of its test data with `data.get()` goes back to
  the author instead of testing a made-up id; and a record put under `data` is refused with a message that points to
  `test_data`.
- f6dc14a: `qj explore` takes `--headed` and `--slow-mo <ms>` to watch the agent explore live, and uses the environment
  `qj env up` started for the run when no `--env` is given. `qj env up` waits for Ctrl+C also when the application runs
  in containers. The guard protects `ui/`, the pages recorded before planning.
- 174abe0: Explorers perform actions one at a time when the model asks for several in one turn (REQ-EXEC-15/AC9). Before, the
  concurrent calls shared one action id, their outputs mixed in the live view and evidence of one was lost.
- f26a0ad: Found by exploratory testing of every qj command:
  
  - `qj projects` alone lists the projects (it printed help and exited 3), and the list reports the same readiness as
    `qj status` (it said "ready" for a project whose tools were missing).
  - Requests to Ollama and OpenAI-compatible providers wait up to `timeout_s` of the provider (default 1800 s) instead
    of Node's 5-minute limit for the first byte, which cut off slow thinking models mid-session.
  - A command-line explorer that answers before acting is shown the first command to run, taken from its checklist;
    qwen3 with a long checklist answered three times without any command before.
  - `qj approve` lists the expectations it cannot check with one marker each (they were prefixed twice).
- bcbf786: `qj run` without `--env` or `--build` uses the environment `qj env up` started for the run while it answers, as
  `qj explore` already did; it said nothing and ran every case against `environments.default`, which ended BLOCKED.
  
  `qj status` lists the environments still running for the project's runs, with their URLs and the `qj clean` command
  that stops them; detached demo environments ran unnoticed for days.
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
- 1049e36: An exploratory session whose explorer keeps making claims code refuses no longer ends in error with nothing kept:
  its last answer is corrected by code (refused claims become not done, items an action ran get it), marked "corrected
  by code" and journaled. Session S10 with qwen3 ran ten commands, including a plan, and lost them all this way. A group
  command followed by a subcommand it does not have says "unknown command" again (`qj baseline list`), not "too many
  arguments".
- dcf7a1e: A spec for a case that runs as a test account must log in as it (`api.as(...)` or `ui.as(...)`); one that never does
  is refused and sent back to the author like a missing `verify()`, as is one that drops the client `api.as()` returns or calls the anonymous `api`. A local author wrote `api.get("/cart")` for a case
  with `data.user`, every call got 401, and the cases ended FAILED as if the cart were broken. The demo shop's OpenAPI
  documents login and the 401 of every protected operation, and the plan check also reads `security`.
- 0f5243f: The browser explorer is shown the first calls to make (`explore_look`, then `explore_goto` to `/`) in its prompt and
  when it answers before acting; qwen3 answered three times without acting before and the session ended with nothing.
  Browser sessions print each action, rejected answer and observation in the terminal as they happen, as command-line
  sessions do.
- 8ed96f1: Archiving the active project says that none is active any more, and restoring a project when none is active names
  `qj use <slug>`; before, `qj status` then said "No project selected" with no hint why.
- 3a9ffcc: The element inventory records the platform of each id (web, Android, iOS) and the plan check accepts only ids of the
  case's own platform. Specs of mobile cases are rejected statically when they use what only a browser has (`ui.as`,
  `ui.select`, `ui.goto` without `mobile.deep_link_scheme`, `css:` or `role:` selectors), so the author fixes them
  before the run. A mobile step may check an element before any action, since the app is open from the start.
- a37943a: `qj explore --cli` on Node.js 22: the tool's output no longer starts with Node's "EnvHttpProxyAgent is experimental"
  warning, which the sandbox's proxy setting caused; other warnings of the tool are kept.
- 4aa9f77: The Chroma knowledge store is a plugin (REQ-GEN-11/AC1): `qj plugin add knowledge-chroma`. `qj setup` installs it
  for a project with `knowledge.store: chroma`. The adapter now takes `@qajitsu/core` as a peer dependency.
- 5a56bb3: GitHub and GitHub Enterprise Server as a code host are a plugin (REQ-GEN-11/AC1): `qj plugin add codehost-github`; `qj setup` installs it for a project with a `github` code host. The adapter takes `@qajitsu/core` as a peer dependency; the CodeHost contract, which now accepts an asynchronously built host, runs against the installed plugin.
- 2339516: GitLab.com and GitLab self-managed as a code host are a plugin (REQ-GEN-11/AC1): `qj plugin add codehost-gitlab`; `qj setup` installs it for a project with a `gitlab` code host. The adapter takes `@qajitsu/core` as a peer dependency; the CodeHost contract runs against the installed plugin.
- 4a3e7b8: Starting the application from the worktree (`qj run --build`, `qj env up`) with Docker Compose or managed processes is a plugin (REQ-GEN-11/AC1): `qj plugin add env-compose`; `qj setup` installs it for a project with `build` or compose services. Cleanup and `qj status` skip container work when the plugin is not installed, because without it QAJitsu started none. The EnvProvider contract runs against the installed plugin.
- 57400dc: Write-once storage on S3 Object Lock is a plugin (REQ-GEN-11/AC1): `qj plugin add evidence-s3`; `qj setup` installs it for a project with `archive`. The adapter takes `@qajitsu/core` as a peer dependency and passes the new EvidenceArchive contract, also as installed.
- 70230a0: Confluence as a knowledge source is a plugin (REQ-GEN-11/AC1): `qj plugin add knowledge-confluence`; `qj setup` installs it for a project with `knowledge.confluence`. The adapter takes `@qajitsu/core` as a peer dependency and passes the new DocumentSource contract, also as installed.
- d02951b: Message capture on webhook.site is a plugin (REQ-GEN-11/AC1): `qj plugin add messages-webhooksite`; `qj setup` installs it for a project with `messages`. A run loads it when the first inbox is needed. The adapter takes `@qajitsu/core` as a peer dependency and passes the new MessageCapture contract, also as installed.
- 4acbbd3: Publishing to Jira (the result comment, attachments, bug reports, the workflow and attachment downloads for `qj pull`) is a plugin (REQ-GEN-11/AC1): `qj plugin add publish-jira`; `qj setup` installs it for a project with `jira.type: cloud` or `datacenter`. Publishing to files stays in the core. The CLI loads it on first use; the Publisher contract runs against the installed plugin.
- b41852e: The API runner, which drives every lane of a run, is a plugin (REQ-GEN-11/AC1): `qj plugin add runner-api`, installed by `qj init` and `qj setup` for every project. The adapter takes `@qajitsu/core` and `@qajitsu/steps` as peer dependencies. The AttemptExecutor contract runs on the production sandbox started from the installed plugin's own folder. The web and mobile runners are now needed only for the test types that use them.
- abde35b: The mobile runner (Appium, Android emulators, device farms) is a plugin (REQ-GEN-11/AC1): `qj plugin add runner-mobile`; `qj setup` installs it for a project with mobile tests, together with the API runner it needs. A run with mobile cases loads it before any lane starts. `webdriverio` is pinned to `9.32.0`. A new device factory contract on a fake Appium client runs on the source and on the installed plugin.
- d715935: The web runner (Playwright browsers, screenshots, video, trace, visual checks, browser logins) is a plugin (REQ-GEN-11/AC1): `qj plugin add runner-web`; `qj setup` installs it for a project with `test_types: [web]`, together with the API runner it needs. A run loads it only when the plan has web cases or a spec drives a browser. `playwright-core` is now pinned to `1.63.0` in the CLI and the runners, because the browsers are installed for one version.
- 001e25a: Secret managers through their CLIs (1Password `op`, AWS Secrets Manager `aws`, GCP Secret Manager `gcloud`) are a plugin (REQ-GEN-11/AC1): `qj plugin add secrets-cli`; `qj setup` installs it for a project with `secrets.op`, `secrets.aws` or `secrets.gcp`. It loads on the first lookup of one of those schemes. The adapter takes `@qajitsu/core` as a peer dependency.
- 16c2cf2: Doppler as a secret provider is a plugin (REQ-GEN-11/AC1): `qj plugin add secrets-doppler`; `qj setup` installs it for a project with `secrets.doppler`. It loads on the first `secret://doppler/` lookup. The adapter takes `@qajitsu/core` as a peer dependency.
- 11279f6: HashiCorp Vault as a secret provider is a plugin (REQ-GEN-11/AC1): `qj plugin add secrets-vault`; `qj setup` installs it for a project with `secrets.vault`. The CLI loads it on the first `secret://vault/` lookup, so other references never need it. The adapter takes `@qajitsu/core` as a peer dependency.
- 9559491: Manual test cases from Xray, Zephyr Scale and TestRail are a plugin (REQ-GEN-11/AC1): `qj plugin add testcases`; `qj setup` installs it for a project with such `test_cases`. Cases from CSV and Excel files stay in the core. The adapter takes `@qajitsu/core` as a peer dependency and passes the new TestCaseSource contract, also as installed.
- 039bb2e: The Jira ticket source (Cloud and Data Center) is a plugin (REQ-GEN-11/AC1): `qj plugin add ticket-jira`; `qj setup` installs it for a project with `jira.type: cloud` or `datacenter`. Tickets from files stay in the core. The adapter takes `@qajitsu/core` as a peer dependency; the TicketSource contract runs against the installed plugin.
- a09505a: Signed release images (REQ-GEN-09):
  
  - Every release is published as `ghcr.io/bogiloco/qajitsu` for amd64 and arm64, built from the published packages.
  - Every dependency is pinned to the versions this repository tests.
  - Each image ships with an SBOM and build provenance, is signed and is verified after the push.
  - `docker run --rm ghcr.io/bogiloco/qajitsu demo` runs the demo-shop flow offline.
  - A run in the image records it by digest, marked as declared by whoever started the container (`-e QAJITSU_IMAGE_DIGEST`), and says so when the digest was not given. `qj doctor` shows the same line.
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
- fc55fef: Tests repository awareness: a repository with `role: tests` is checked out at its default branch on every fetch
  (marked `role: tests` in `run.json`, excluded from the deployed-version check). The planner sees an index of its
  tests and may list `existing_coverage` in the plan; every claim must name a real file and test title and real
  criteria (checked by code). The author gets the repository's selector strategy, page-object selectors and
  convention documents.
- 58cdf54: `androidSdkRoot` and `channelExecutables` move to `@qajitsu/toolchain`, so `qj doctor` and the tool versions can find the
  Android SDK and branded browsers without the runner plugins (REQ-GEN-11/AC1). The runners still re-export them.
  `qj setup --smoke` loads the mobile runner plugin only when it boots an emulator.
- 08e6842: The recorded traffic is read by code (REQ-EVD-09/AC1+AC2): every request of the page is tied to its step; a failed or
  blocked step lists the requests that went wrong (5xx, 4xx, timeouts, connection errors, allowlist refusals, CORS,
  redirects to login) in `steps[].network`, `S1-network.json` and next to the failure in the report, and the failure
  hints get it as structured data. Every attempt records the pages and endpoints it reached (`attempts[].requests`),
  and the report lists which case reached which endpoint of the change. Web cases can check the page's WebSocket
  messages (REQ-EXEC-47/AC3): `websocket.received.<n>` and `websocket.sent.<n>`, frames kept per step. Plan checks also
  flag a dialog without an answer, invented manifest elements, and count a changed page as covered by a web case that
  opens it. The demo shop gets a support chat over a WebSocket with BUG-17.
- 6338f4c: A command-line usage problem (missing argument, unknown option or command) exits 3 instead of 1, which pipelines read
  as "a test FAILED"; `--help` and `--version` exit 0. Found by an exploratory session of `qj` with `qj explore --cli`.
- Updated dependencies [322dcb3]
- Updated dependencies [18f9746]
- Updated dependencies [603cb14]
- Updated dependencies [6da421c]
- Updated dependencies [fbf85d7]
- Updated dependencies [ae9a935]
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
- Updated dependencies [36a1b10]
- Updated dependencies [a3ab148]
- Updated dependencies [d04a6f2]
- Updated dependencies [e1dbaa2]
- Updated dependencies [cb3a977]
- Updated dependencies [068ee8d]
- Updated dependencies [8384943]
- Updated dependencies [de56650]
- Updated dependencies [4585559]
- Updated dependencies [e387a21]
- Updated dependencies [20ae077]
- Updated dependencies [730f710]
- Updated dependencies [5661a8c]
- Updated dependencies [ac46226]
- Updated dependencies [b587262]
- Updated dependencies [3708575]
- Updated dependencies [47fac1e]
- Updated dependencies [7de9efc]
- Updated dependencies [c268171]
- Updated dependencies [693612b]
- Updated dependencies [b17d302]
- Updated dependencies [1b0fc13]
- Updated dependencies [f26a0ad]
- Updated dependencies [e42695e]
- Updated dependencies [1595612]
- Updated dependencies [1049e36]
- Updated dependencies [dcf7a1e]
- Updated dependencies [0f5243f]
- Updated dependencies [0a4b201]
- Updated dependencies [59cba3d]
- Updated dependencies [856f330]
- Updated dependencies [44af6d7]
- Updated dependencies [86089ff]
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
- Updated dependencies [8424bf7]
- Updated dependencies [b13168a]
- Updated dependencies [69a6c09]
- Updated dependencies [3a9ffcc]
- Updated dependencies [52ebfb2]
- Updated dependencies [83fcb63]
- Updated dependencies [8a03150]
- Updated dependencies [4505978]
- Updated dependencies [adb1475]
- Updated dependencies [24d21c4]
- Updated dependencies [7647358]
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
- Updated dependencies [a1c68c5]
- Updated dependencies [c73286c]
- Updated dependencies [6fb3db3]
- Updated dependencies [6f00289]
- Updated dependencies [353a30c]
- Updated dependencies [7bdae8c]
- Updated dependencies [39d79bd]
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
- Updated dependencies [58cdf54]
- Updated dependencies [b520f06]
- Updated dependencies [08e6842]
- Updated dependencies [5cd2348]
- Updated dependencies [3c97959]
- Updated dependencies [24308e8]
- Updated dependencies [c2d6ffe]
- Updated dependencies [1fc2482]
  - @qajitsu/adapter-files@0.1.0
  - @qajitsu/core@0.1.0
  - @qajitsu/steps@0.1.0
  - @qajitsu/agents@0.1.0
  - @qajitsu/verifier@0.1.0
  - @qajitsu/models@0.1.0
  - @qajitsu/report@0.1.0
  - @qajitsu/toolchain@0.1.0
  - @qajitsu/adapter-env-remote@0.1.0
  - @qajitsu/adapter-evidence-local@0.1.0
  - @qajitsu/adapter-codehost-local@0.1.0
  - @qajitsu/adapter-secrets-env@0.1.0
