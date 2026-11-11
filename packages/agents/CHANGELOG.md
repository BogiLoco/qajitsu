# @qajitsu/agents

## 0.1.0

### Minor Changes

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
- f431a44: Exploratory sessions of command-line tools (REQ-EXEC-24): `qj explore <ticket> --cli <tool>` lets the explorer use any
  tool described in `explore.cli` (QAJitsu's own `qj` in the demo shop) in a throwaway sandbox with its own HOME, only
  the configured variables, an allowlist proxy and argument arrays; every command's exit code, output and changed files
  are recorded with SHA-256, leftover processes and containers are found and stopped, and `qj explore promote` writes a
  regression test proposal for an observation.
- 8125f74: `code: { access: full | metadata | none }` (REQ-CTX-10): a project can keep its code from QAJitsu. With `metadata`
  only the PR/MR title, description and changed file names are kept; with `none` nothing is read from the code hosts.
  Agents are told, `--build` says it needs the code, and the report header and `qj fetch` say what was shared.
- 36a1b10: The tests-repository index is cached per project by `<repo>@<sha>` in `<project-home>/cache/index/` and reused by later runs on the same commit; corrupt entries are rebuilt, and `qj clean --project` removes entries unused for `cleanup.max_age_days`.
- a3ab148: Context budgets (REQ-LLM-15, REQ-CTX-12, REQ-CTX-14): every model has a context profile (working range below the
  window, answer reserve, token margin per family, provider counting for Anthropic, cache style, compact style for small
  windows and local models; `working_range` and `context_style` per model in `models.providers`). Calls that fit are
  sent as they are; otherwise the context manager reduces by code: on-demand material and what matches nothing of the
  task go behind handles, large diffs and logs are trimmed with their structure kept, then the least relevant fragments
  follow; pinned fragments are never touched and a call they alone overflow is refused. Agents read handles with
  `read_context` and find them with `search_context`; reads are journaled. Snapshots carry the budget, the catalogue and
  the relevance ranking; `qj logs` shows them in one line. Tool results are wrapped in the run's data blocks.
- d04a6f2: Compaction of long agent loops (REQ-CTX-16): before every step of a tool loop, and before every repair round, the
  conversation is compacted only when the next call would not fit the budget; the oldest tool results the loop no
  longer refers to are replaced by a one-line note built by code, with the full result behind a handle that
  `read_context` reads (every role with a budget now gets the catalogue tools). The assembled input, the last two
  results and every result the latest turn names stay whole; each compaction is journaled as `context.compacted`.
- cb3a977: Context manager, first phase (ADR-0014, REQ-CTX-11..17): model input as fragments with kind, source, trust, layout,
  priority, pin, tokens and hash (`ContextFragmentSchema`, `fragment()`); `createContextManager()` lays them out in a
  fixed order, renders untrusted data in blocks bounded by a marker drawn once per run (content cannot close them, in any
  letter case), enforces which kinds a role may see (`ROLE_CONTEXT`), and records a snapshot whose hash goes into the
  journal. The auditor and triage are migrated; the auditor never receives analysis, diffs or tool transcripts.
- 068ee8d: Context manager, second phase (REQ-CTX-11/AC3, REQ-CTX-13): every agent role (analyst, planner, author, healer,
  approver, explorers, blocked hints) builds its input from fragments; `runStructuredAgent` and `prepareCall` accept only
  an assembled context, so no prompt can be built around the manager. Every role declares the kinds of context it may
  see; the approver and the auditor never see the analysis or tool transcripts. New fragment kinds `spec`, `ui`,
  `imported`, `exploration`, `map`. `renderTestsRepo` returns plain text; `renderChangeContext` renders the same
  fragments for previews.
- de56650: Model inputs rebuilt from their snapshots (REQ-CTX-17/AC4): every model call keeps the texts of the fragments it
  showed in the run, by hash (`context/fragments/<sha256>.txt`). `qj audit verify` rebuilds each call's input from its
  `context.snapshot` (trimming applied again by code, rendered with the run's marker) and names every fragment that
  changed or is missing; `qj reproduce` reports the same for the certified run before running it again. Runs from
  before this change are skipped. `renderFragments` and `rebuildCall` are exported from `@qajitsu/agents`.
- 4585559: Shares of the context budget per source (REQ-CTX-14/AC1): `models.context_shares` (e.g. `{ diff: 0.5, knowledge: 0.2 }`,
  at most 1 together) reaches every model's context profile. Over the budget, a source kind over its share is reduced
  first, the furthest over first and only as far as the call needs, with the usual code reductions; shares a kind does
  not use go to the others, and a call that fits is sent whole. The shares that applied are recorded in the snapshot.
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
- ac46226: Test depth, estimate and budget (REQ-PLAN-08): `qj plan --depth smoke|standard|full` keeps cases by risk (priority) and records the depth and why each case is in or out; every run starts with an estimate of execution time and model use from the project's past runs; `budget: { max_minutes, max_cost_usd }` makes the remaining cases NOT_RUN with the reason. plan.md also shows manual steps, messages, visual checks and locales.
- b587262: `qj doctor` reports a missing tool once (the Android SDK covers its emulator, Appium its drivers, Docker Compose),
  warns when `.env.local` can be read by other users of the machine (`chmod 600`), and `qj doctor --models` checks only
  the models, including the approval flow's model (REQ-GEN-08).
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
- dcca1a0: Locale runs (REQ-EXEC-14): project `locales` with time zones; plan cases list their locales and give per-locale expected values (`expect.by_locale`, only planned keys); each locale runs with the plan resolved for it (`planForLocale`), the browser locale and time zone and an `Accept-Language` header; the case is PASSED only if every locale passed; reports show the status per locale.
- 3c66a3b: Manual steps (REQ-EXEC-11, ADR-0008): plan steps can be `manual: true` with instructions; the run asks a tester in the terminal or waits for `qj answer` in CI; the answer is an assertion with `source: manual`, who and when, plus evidence; failed → FAILED, no answer → BLOCKED; reports name who performed each manual step; agents cannot answer (guard). `manual.timeout_s`.
- 112d074: Map as planner input (REQ-OBS-08): `qj plan` builds the application map of every past run and stores the part around the change in `map/around.json` (touched screens and endpoints, never tested ones next to them, transitions from or to them). The planner sees it as untrusted data and may add regression cases citing `{kind: map, id}`, checked by code; the guard protects `map/`. New `mapAroundChange` in the report package and `collectAppMap` behind `qj map`.
- b13168a: The author can explore the application through MCP servers (`mcp.servers`, e.g. Playwright MCP) to find selectors.
  Servers start without a shell, with a minimal environment, in a temporary folder outside the run; only the listed
  tools are offered, every call goes through the guard and the journal, `url` inputs are checked against the
  environment allowlist, images are not stored, and exploration never produces results or evidence. New dependency:
  `@ai-sdk/mcp` (the AI SDK's MCP client, already part of the stack).
- 69a6c09: Message capture (REQ-ENV-08): `messages:` (webhook.site, hosted or self-hosted) gives every case its own inbox; plan steps can expect a message (`expect.message`: to, subject, body, within_s), specs use `inbox.address()` and `inbox.wait()`, the trusted runtime matches against the plan, keeps the masked message as evidence and fails the step when none arrives; inboxes are deleted when the run ends. Spec type checks now read the `@qajitsu/steps` sources in the monorepo.
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
- e1dbaa2: Smarter last reductions, found by dogfooding the planner with a local model: over the budget, the least relevant
  fragment per token goes behind a handle first (a large page recording before a smaller, denser analysis); fragments no
  larger than their catalogue line are never put behind a handle; and the catalogue's own lines count in the budget, so a
  call never ends over it.
- 730f710: Logins for real web applications (REQ-EXEC-67): the HTTP login can use the `Set-Cookie` of its response as the
  session (no `token_path`), login scripts can print `cookies` or a Playwright `storage_state`, and `web_session:
  { storage: cookies }` makes `ui.as(alias)` load them for the application's origin only. `ui.fillSecret(selector, alias,
  "password" | "username")` types an account's secret into a login form: the runner resolves it, screenshots black the
  field out, and specs, agents, evidence and the journal see only the mask. Traces kept as evidence are now masked,
  including sensitive headers and cookies the application set during the test. `zip`/`unzip` moved to
  `@qajitsu/core` (still exported by `@qajitsu/report`). Demo shop: sign-in with an HttpOnly cookie and BUG-18 (DEMO-13).
- 3708575: The planner's page snapshot also records the pages the code defines when no link reaches them (an offer page no menu
  links to), so the plan sees their real texts; asset paths (`/sw.js`, `/manifest.webmanifest`) are no longer counted
  as pages. A plan whose element key lacks its selector kind (`offer-status`) gets a repair hint naming
  `testid:offer-status`.
- f26a0ad: Found by exploratory testing of every qj command:
  
  - `qj projects` alone lists the projects (it printed help and exited 3), and the list reports the same readiness as
    `qj status` (it said "ready" for a project whose tools were missing).
  - Requests to Ollama and OpenAI-compatible providers wait up to `timeout_s` of the provider (default 1800 s) instead
    of Node's 5-minute limit for the first byte, which cut off slow thinking models mid-session.
  - A command-line explorer that answers before acting is shown the first command to run, taken from its checklist;
    qwen3 with a long checklist answered three times without any command before.
  - `qj approve` lists the expectations it cannot check with one marker each (they were prefixed twice).
- e42695e: An exploratory session no longer loses its whole checklist over one finding: a finding or comment code cannot confirm
  is sent back once and then dropped and journaled (`explore.claim_dropped`), and text the explorer quotes from a tool's
  output is not taken as a command it claims to have run. Session S09 with qwen3 ran 13 commands and lost everything
  because a finding quoted the message "qj init".
- 1049e36: An exploratory session whose explorer keeps making claims code refuses no longer ends in error with nothing kept:
  its last answer is corrected by code (refused claims become not done, items an action ran get it), marked "corrected
  by code" and journaled. Session S10 with qwen3 ran ten commands, including a plan, and lost them all this way. A group
  command followed by a subcommand it does not have says "unknown command" again (`qj baseline list`), not "too many
  arguments".
- 0f5243f: The browser explorer is shown the first calls to make (`explore_look`, then `explore_goto` to `/`) in its prompt and
  when it answers before acting; qwen3 answered three times without acting before and the session ended with nothing.
  Browser sessions print each action, rejected answer and observation in the terminal as they happen, as command-line
  sessions do.
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
- 3a9ffcc: The element inventory records the platform of each id (web, Android, iOS) and the plan check accepts only ids of the
  case's own platform. Specs of mobile cases are rejected statically when they use what only a browser has (`ui.as`,
  `ui.select`, `ui.goto` without `mobile.deep_link_scheme`, `css:` or `role:` selectors), so the author fixes them
  before the run. A mobile step may check an element before any action, since the app is open from the start.
- df9aa5c: Projects (ADR-0006): `qj init <slug>` registers a project in `~/.qajitsu/projects/<slug>/` (runs, git cache, knowledge,
  exports, logs) and links or creates its `.qa/`; `qj use`, `qj projects list|current` switch between projects. Every
  command resolves its project from `--project`, `QAJITSU_PROJECT`, the ticket prefix or the active project (never the
  current folder), names it on its first output line and records it in `run.json`; a run is only continued in its
  project. Run folders and git mirrors default to the project home. The guard denies reads outside the run workspace.
  CI registers the checked-out `.qa/` in a temporary home.
- 32c1b62: Installable web apps and offline mode (REQ-EXEC-65): a web case can allow service workers with
  `browser.service_workers: true` (Chromium only, where every request of the worker stays on the allowlist; elsewhere the
  case is BLOCKED with the reason), a step can go offline and back with `ui.setOffline(true|false)`, and `manifest.*`
  checks the page's web app manifest (`name`, `short_name`, `start_url`, `display`, number of `icons`) and whether a
  service worker controls the page (`manifest.controlled`). The author's prompt now also lists `ui.advanceTime()`.
- 28ab015: Automated logins for test environments (REQ-EXEC-55): accounts can carry a TOTP seed (`totp: secret://...`) whose
  codes QAJitsu computes when they are typed (`ui.fillSecret(sel, alias, "totp")`, `{{totp}}`, `QAJITSU_TOTP` for login
  scripts); `ui.fillCode(sel)` types the code of the e-mail or SMS the step's plan expects (`message.code` pattern), and
  no message in time fails that check; `login: { browser: ... }` runs SSO through the identity provider's pages with
  redirects, keeps only the application's own session, loads only allowlisted provider origins and reuses one login per
  account and run; `test_headers` sends the application's test mechanisms (a captcha bypass) to its own origin only.
  Captchas are never solved. The planner's answer gets missing evidence filled by code; plan flags about texts the
  recorded pages show differently no longer block approval. Demo shop: a fictional identity provider with TOTP.
- 08e6842: The recorded traffic is read by code (REQ-EVD-09/AC1+AC2): every request of the page is tied to its step; a failed or
  blocked step lists the requests that went wrong (5xx, 4xx, timeouts, connection errors, allowlist refusals, CORS,
  redirects to login) in `steps[].network`, `S1-network.json` and next to the failure in the report, and the failure
  hints get it as structured data. Every attempt records the pages and endpoints it reached (`attempts[].requests`),
  and the report lists which case reached which endpoint of the change. Web cases can check the page's WebSocket
  messages (REQ-EXEC-47/AC3): `websocket.received.<n>` and `websocket.sent.<n>`, frames kept per step. Plan checks also
  flag a dialog without an answer, invented manifest elements, and count a changed page as covered by a web case that
  opens it. The demo shop gets a support chat over a WebSocket with BUG-17.
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
- Updated dependencies [a3ab148]
- Updated dependencies [cb3a977]
- Updated dependencies [068ee8d]
- Updated dependencies [8384943]
- Updated dependencies [4585559]
- Updated dependencies [e387a21]
- Updated dependencies [20ae077]
- Updated dependencies [730f710]
- Updated dependencies [5661a8c]
- Updated dependencies [ac46226]
- Updated dependencies [3708575]
- Updated dependencies [47fac1e]
- Updated dependencies [7de9efc]
- Updated dependencies [c268171]
- Updated dependencies [693612b]
- Updated dependencies [b17d302]
- Updated dependencies [1b0fc13]
- Updated dependencies [f26a0ad]
- Updated dependencies [1595612]
- Updated dependencies [1049e36]
- Updated dependencies [dcf7a1e]
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
- Updated dependencies [08e6842]
- Updated dependencies [5cd2348]
- Updated dependencies [24308e8]
- Updated dependencies [c2d6ffe]
- Updated dependencies [1fc2482]
  - @qajitsu/core@0.1.0
  - @qajitsu/steps@0.1.0
  - @qajitsu/verifier@0.1.0
  - @qajitsu/models@0.1.0
  - @qajitsu/guard@0.1.0
