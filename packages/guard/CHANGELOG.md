# @qajitsu/guard

## 0.1.0

### Minor Changes

- 2abbf5d: Import existing manual test cases (REQ-CTX-08): `test_cases:` in the project configuration reads the cases linked to a ticket from Xray Cloud, Zephyr Scale, TestRail or a CSV/Excel file during `qj fetch` into `imported/cases.json`. The planner gets them as untrusted data and cites them as `{kind: imported, id}`, which code checks against the imported ids; a source that cannot be reached is reported and planning continues. The guard protects `imported/`. New package `@qajitsu/adapter-testcases`, `TestCaseSource` interface and `xlsxRows` in core.
- 0efd727: Analyst and planner search the project's documentation with `search_docs` (all of it in the prompt for small knowledge bases). Plans cite documentation as `{"kind":"doc","chunk","quote"}`; code checks the quote verbatim against the chunk the run was given (`knowledge/chunks.json`, protected from agents) and fills in path, section, date and a "possibly outdated" warning. `knowledge.auto_sync` syncs sources before `qj plan`.
- 2d298c8: Live progress of a run (REQ-OBS-09): `qj run` prints each case start with a counter, each step and each attempt outcome as plain lines; the runner journals `step.start` as steps begin. `qj watch <TICKET>` serves a page on 127.0.0.1 with the cases, the step running now, the latest screenshot (`<run>/live/`, not evidence) and preliminary outcomes, then the computed statuses; a run that stopped is shown as stopped. New optional `progress` on `AttemptRequest` (`AttemptProgress`) and `onScreenshot` on the case runtime; the guard protects `live/`.
- 3c66a3b: Manual steps (REQ-EXEC-11, ADR-0008): plan steps can be `manual: true` with instructions; the run asks a tester in the terminal or waits for `qj answer` in CI; the answer is an assertion with `source: manual`, who and when, plus evidence; failed → FAILED, no answer → BLOCKED; reports name who performed each manual step; agents cannot answer (guard). `manual.timeout_s`.
- 112d074: Map as planner input (REQ-OBS-08): `qj plan` builds the application map of every past run and stores the part around the change in `map/around.json` (touched screens and endpoints, never tested ones next to them, transitions from or to them). The planner sees it as untrusted data and may add regression cases citing `{kind: map, id}`, checked by code; the guard protects `map/`. New `mapAroundChange` in the report package and `collectAppMap` behind `qj map`.
- 3ec9d51: The guard holds every plugin to its manifest (REQ-GEN-11/AC4+AC9, ADR-0015). `@qajitsu/guard` adds
  `checkPluginCode`. At install, and again before an installed plugin is loaded, the plugin's own code is checked
  against its permissions: Node's network, process and file modules, reads of `process.env` and the global `fetch`. A
  plugin that does more than it declares, or that refers to the frozen plan, is refused. Every HTTP call of an
  integration plugin goes through a guarded `fetch` that allows only its manifest's hosts and the URLs the project
  configures for it. Plugin manifests get the `environment` permission, and five manifests that understated their code
  are corrected.
- df9aa5c: Projects (ADR-0006): `qj init <slug>` registers a project in `~/.qajitsu/projects/<slug>/` (runs, git cache, knowledge,
  exports, logs) and links or creates its `.qa/`; `qj use`, `qj projects list|current` switch between projects. Every
  command resolves its project from `--project`, `QAJITSU_PROJECT`, the ticket prefix or the active project (never the
  current folder), names it on its first output line and records it in `run.json`; a run is only continued in its
  project. Run folders and git mirrors default to the project home. The guard denies reads outside the run workspace.
  CI registers the checked-out `.qa/` in a temporary home.
- 5c6c8f2: Stage 1: `qajitsu fetch <TICKET>` creates a run folder with the ticket snapshot, discovered PRs/MRs/branches, diffs,
  review comments and git worktrees at the exact SHA. Adds Jira Cloud and file ticket sources, GitHub (incl. GHES and
  GitHub App), GitLab (incl. self-managed) and local code hosts, the `env` secret provider, the run event log and masked
  arguments in the guard journal. `createJournal` now requires a masking function.
- 15a7965: Stage 7: auditor, canary and model benchmark. An independent auditor agent (fresh context, by default a model other
  than the author's) reviews every PASSED case against the approved plan, raw results, text evidence and screenshots;
  its findings and the canary (one PASSED case re-run with an inverted expectation) can only move PASSED to
  NEEDS_REVIEW (`verification` section, `checks/` records protected by the guard, notes in report.html). Every planned
  expectation now needs its own `verify()`: specs that leave one out are blocked, results without it are never PASSED.
  `qajitsu bench --model <ref> [--role]` runs `.qa/bench.yaml` end to end with `--build` and reports detection, false
  FAILED, BLOCKED, plan acceptance, time, tokens and cost. `runStructuredAgent` accepts images; `ModelPorts` accepts a
  run-level model override.

### Patch Changes

- c268171: Exploratory sessions: `qj explore <TICKET> --goal "..." [--time-box <min>] [--max-steps <n>]` lets the new `explorer`
  agent explore the application through browser actions QAJitsu performs and records (screenshots, video, trace,
  network, console in the evidence manifest). Observations cite the recorded actions as steps to reproduce; the session
  writes `explore/<session>/report.html` and `report.md` for review and never produces statuses. `qj explore promote`
  turns an observation into a draft plan case with a new `observation` source kind; it runs only after approval.
  `explore/` is protected from agent writes.
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
