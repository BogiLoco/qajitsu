# @qajitsu/report

## 0.1.0

### Minor Changes

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
- 016d940: Waiting for asynchronous outcomes (REQ-EXEC-46): a plan step may set `wait: { timeout_s, interval_s }`. The runtime,
  in process and in the sandbox, repeats the step's actions and checks until every planned expectation of the step
  holds or the time is up; the interval does not count against the case's time limit. Every round is evidence
  (`<step>-wait.json`), the attempt records `wait: { waitedMs, rounds, met }` per step and `report.html` shows it; a
  check not met in time fails with the last observed value, and a round that leaves out a planned check never counts as
  met. The planner prompt and the plan review show the wait. The demo shop's documents are processed for two seconds
  (BUG-22: never ready).
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
- 8125f74: `code: { access: full | metadata | none }` (REQ-CTX-10): a project can keep its code from QAJitsu. With `metadata`
  only the PR/MR title, description and changed file names are kept; with `none` nothing is read from the code hosts.
  Agents are told, `--build` says it needs the code, and the report header and `qj fetch` say what was shared.
- 8384943: Context metrics and policies (REQ-CTX-18): `qj metrics` exports per role and model the estimated input tokens by
  fragment kind, reductions by action, assembled inputs, `read_context` and `search_context` calls and the prompt cache
  hit rate (`contextUsage` / `mergeContextUsage` in `@qajitsu/report`). `qj bench --context <policies>` runs every case
  once per context policy (`default`, `full`, `compact`, `range=<tokens>`, combined with `+`), reports detection, plan
  quality, tokens, cost and time per policy and names the cheapest policy that keeps the best quality. The model
  registry takes a `contextPolicy` that wins over every model's own working range and style.
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
- 44af6d7: Every run ends with a GO / NO-GO / NO DECISION decision computed by code from the statuses and the plan's
  priorities, with the cases that caused it, in the terminal, matrix, report, junit, `qj evidence`, `qj export` and the
  ticket comment; `decision:` in the project config can tolerate statuses of lower priority cases (REQ-PUB-10).
  An invalid configuration now names every problem in its message for every command, and `qj doctor` reports it once.
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
- dcca1a0: Locale runs (REQ-EXEC-14): project `locales` with time zones; plan cases list their locales and give per-locale expected values (`expect.by_locale`, only planned keys); each locale runs with the plan resolved for it (`planForLocale`), the browser locale and time zone and an `Accept-Language` header; the case is PASSED only if every locale passed; reports show the status per locale.
- 3c66a3b: Manual steps (REQ-EXEC-11, ADR-0008): plan steps can be `manual: true` with instructions; the run asks a tester in the terminal or waits for `qj answer` in CI; the answer is an assertion with `source: manual`, who and when, plus evidence; failed → FAILED, no answer → BLOCKED; reports name who performed each manual step; agents cannot answer (guard). `manual.timeout_s`.
- 112d074: Map as planner input (REQ-OBS-08): `qj plan` builds the application map of every past run and stores the part around the change in `map/around.json` (touched screens and endpoints, never tested ones next to them, transitions from or to them). The planner sees it as untrusted data and may add regression cases citing `{kind: map, id}`, checked by code; the guard protects `map/`. New `mapAroundChange` in the report package and `collectAppMap` behind `qj map`.
- 8424bf7: `qajitsu map` aggregates the transition graphs of every run into an application map (`map.json`, `map.html`) with
  tested and never-tested screens and API operations (REQ-OBS-07). The Claude Code plugin in `plugin/` (marketplace in
  `.claude-plugin/`) adds `/qa-plan`, `/qa-run` and `/qa-evidence` for chat-driven use, with approval always left to the
  user (REQ-GEN-04). `ops/grafana` is a local OpenTelemetry Collector, Tempo, Loki, Prometheus and Grafana stack with the
  QAJitsu overview dashboard (REQ-OBS-04/AC3).
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
- a1c68c5: Regression runs of promoted packs (REQ-EXEC-17): `qj regression [--env] [--packs] [--from] [--ref] [--publish]` runs every pack `qj promote` put in the tests repository again as a run of its ticket, with the sandboxed runners and no agent or model (no authoring, healing, auditor or triage). Specs and expected values are checked against the pack's hashes; a mismatch makes the case BLOCKED. The suite report (`regression.md`, `report.html`, `junit.xml`) lists regressions. `qj promote` now records `cases_sha256` in `expectations.yaml`.
- 6fb3db3: Release readiness report (REQ-PUB-09): `qj release <fixVersion>` (or `--sprint <name>`) collects every ticket of the release from Jira (JQL on the project's fix version or sprint) or the file source (`fixVersions`, `sprint`), evaluates each ticket's latest executed run with the same code as `qj publish` and writes `exports/releases/<name>.md`: status counts, open cases, tickets without a run (never ready) and runs whose gates fail (untrusted). `--publish <KEY>` posts it as a comment after a preview. `TicketSource.findTickets` is a new optional method.
- cbd6fbb: Stage 10: CI/CD. `qajitsu ci detect` finds the trigger (labelled PR/MR with the ticket key in branch or title, `/qa
  approve` and `/qa revise` comments from people with write access, manual runs, Jira automation dispatches) and
  writes GitHub outputs; `qajitsu ci publish-plan` posts the plan to Jira; `qajitsu ci comment` keeps one updatable
  PR/MR comment and sets the `qajitsu/<TICKET>` status check (`upsertComment`, `setCommitStatus` on GitHub and
  GitLab). `qajitsu approve --approver` records who approved in CI and `--reuse-from <run|latest>` reuses an approved
  plan only when the ticket is unchanged. Every report now includes `junit.xml`; `qajitsu export` writes the pipeline
  artifacts. `QAJITSU_WORKSPACE` overrides the workspace root. Ready-made integrations: GitHub Action and workflow,
  GitLab CI template, Docker image and Jenkinsfile in `ci/`. REQ-EXEC-05/AC1 reworded to match ADR-0004; the demo
  model now uses its full 128k context.
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
- 08e6842: The recorded traffic is read by code (REQ-EVD-09/AC1+AC2): every request of the page is tied to its step; a failed or
  blocked step lists the requests that went wrong (5xx, 4xx, timeouts, connection errors, allowlist refusals, CORS,
  redirects to login) in `steps[].network`, `S1-network.json` and next to the failure in the report, and the failure
  hints get it as structured data. Every attempt records the pages and endpoints it reached (`attempts[].requests`),
  and the report lists which case reached which endpoint of the change. Web cases can check the page's WebSocket
  messages (REQ-EXEC-47/AC3): `websocket.received.<n>` and `websocket.sent.<n>`, frames kept per step. Plan checks also
  flag a dialog without an answer, invented manifest elements, and count a changed page as covered by a web case that
  opens it. The demo shop gets a support chat over a WebSocket with BUG-17.
- 5cd2348: Failure hints (REQ-VER-12): a `triage` role suggests product bug, test bug, environment or data for each FAILED case, citing steps, assertions, evidence or logs; code keeps only real citations, hints never change a status, and they show in the matrix, report and Jira comment. `verification.triage: on|off`.
- 3c97959: Versions (REQ-GEN-03/AC4+AC5, REQ-OBS-10): `qj doctor` ends with the versions of QAJitsu, the system, Node.js, git, Docker and Compose, Playwright and each browser, Java, the Android SDK, emulator, Appium and its drivers (missing tools the project needs are errors with the install command) and of the application under test (git mirror, default branch and latest run per repository; with `--online` the remote and the version deployed on each environment; where the mobile binary comes from). Every run records the tool and model versions it used in `run.json`; `report.html`, the ticket comment, `qj runs` and `qj evidence` show them; `qj promote` keeps them in the pack, and `qj regression` and `qj run --fix-check` list the versions that differ.

### Patch Changes

- e6bc0fd: Command-line exploratory sessions after the security and code review: Ctrl+C or SIGTERM stops the session and still
  cleans up everything it started and removes the sandbox; the time box stops a running command and queued ones never
  start; output of background commands is masked as a whole so a secret printed across two reads stays masked; the live
  view keeps background lines whole, masks multi-line secrets line by line, and strips terminal escape sequences from
  everything shown or recorded; more argument forms that name paths outside the sandbox are refused (`-o/x`, `--out:/x`,
  `@/x`, `file:` URLs, links out of the sandbox); `.env*` and `.qa-runs` of a fixture are never copied or read; the proxy
  drops hop-by-hop and `Proxy-Authorization` headers; `explore.cli.<tool>.allowlist` takes http(s) origins only; agent
  text in `report.md` cannot form links or images. The explorer's checklist check accepts `qj doctor` in backticks or
  quotes, ignores prose such as "qj prints help", and refuses items of `--check` swapped in the answer.
- 730f710: Logins for real web applications (REQ-EXEC-67): the HTTP login can use the `Set-Cookie` of its response as the
  session (no `token_path`), login scripts can print `cookies` or a Playwright `storage_state`, and `web_session:
  { storage: cookies }` makes `ui.as(alias)` load them for the application's origin only. `ui.fillSecret(selector, alias,
  "password" | "username")` types an account's secret into a login form: the runner resolves it, screenshots black the
  field out, and specs, agents, evidence and the journal see only the mask. Traces kept as evidence are now masked,
  including sensitive headers and cookies the application set during the test. `zip`/`unzip` moved to
  `@qajitsu/core` (still exported by `@qajitsu/report`). Demo shop: sign-in with an HttpOnly cookie and BUG-18 (DEMO-13).
- 1049e36: An exploratory session whose explorer keeps making claims code refuses no longer ends in error with nothing kept:
  its last answer is corrected by code (refused claims become not done, items an action ran get it), marked "corrected
  by code" and journaled. Session S10 with qwen3 ran ten commands, including a plan, and lost them all this way. A group
  command followed by a subcommand it does not have says "unknown command" again (`qj baseline list`), not "too many
  arguments".
- 86089ff: The transition graph in `report.html` shows the direction of every step: arrowheads end on the target's border,
  several steps between the same pages or endpoints are drawn apart, a step that stays on the same one is a loop, and
  every edge is labelled with its step (REQ-OBS-06/AC4).
- be9804d: Plans must be checkable: code flags placeholders instead of expected values, fields that are not in the OpenAPI
  response (or have another type), steps with a description only and `testid:` selectors the code does not define;
  the planner gets one automatic round to fix them, the review lists what remains and approving it needs a separate
  confirmation (`qj approve --confirm-placeholders`), recorded in `run.json`. Planner and author get the element ids and
  page paths found in the worktree. Fixes from the demo walkthrough: element expectations shown in the plan review, the
  planner and author prompts describe web and mobile expectations and specs, `verify()` outside its step is rejected
  statically, a reused plan brings its analysis, `qj watch` shows the run's statuses, screenshots go to vision models
  as file parts.
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
