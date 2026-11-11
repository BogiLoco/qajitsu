# @qajitsu/adapter-ticket-jira

## 0.1.0

### Minor Changes

- 322dcb3: New core package `@qajitsu/adapter-files` (REQ-GEN-11/AC1). It holds the adapters that work from local files: tickets
  and their workflow, the publisher and bug tracker that write files, resolved bugs for the knowledge base, and manual
  cases from CSV or Excel. They moved out of `ticket-jira`, `publish-jira` and `testcases`, which no longer export them,
  so those packages can become plugins while a project on files keeps working without any plugin. `@qajitsu/core` now
  exports the helpers these adapters share: `bugMarkdown`, `componentTag`, `toImportedCase` and `MAX_IMPORTED_CASES`.
- 1d4802f: Online knowledge sources: `qj knowledge add confluence:<SPACE>[/<page>]` (Cloud and Data Center) and `jira:bugs[/<component>]` (resolved bugs tagged by component), synced incrementally by page version or issue update time through the new `DocumentSource` interface.
- 039bb2e: The Jira ticket source (Cloud and Data Center) is a plugin (REQ-GEN-11/AC1): `qj plugin add ticket-jira`; `qj setup` installs it for a project with `jira.type: cloud` or `datacenter`. Tickets from files stay in the core. The adapter takes `@qajitsu/core` as a peer dependency; the TicketSource contract runs against the installed plugin.
- 6fb3db3: Release readiness report (REQ-PUB-09): `qj release <fixVersion>` (or `--sprint <name>`) collects every ticket of the release from Jira (JQL on the project's fix version or sprint) or the file source (`fixVersions`, `sprint`), evaluates each ticket's latest executed run with the same code as `qj publish` and writes `exports/releases/<name>.md`: status counts, open cases, tickets without a run (never ready) and runs whose gates fail (untrusted). `--publish <KEY>` posts it as a comment after a preview. `TicketSource.findTickets` is a new optional method.
- 5c6c8f2: Stage 1: `qajitsu fetch <TICKET>` creates a run folder with the ticket snapshot, discovered PRs/MRs/branches, diffs,
  review comments and git worktrees at the exact SHA. Adds Jira Cloud and file ticket sources, GitHub (incl. GHES and
  GitHub App), GitLab (incl. self-managed) and local code hosts, the `env` secret provider, the run event log and masked
  arguments in the guard journal. `createJournal` now requires a masking function.
- b447614: Stage 4: `qajitsu publish` recomputes statuses and gates from disk, shows a preview, then posts the results comment
  (ADF on Jira Cloud, wiki markup on Data Center) with the evidence zip and updates the same comment when a run is
  published again. Adds `qajitsu evidence` for local reproduction, the Jira Data Center ticket source and the
  `publish` configuration section. The `Publisher` interface now takes a rendered comment and returns a result with
  uploaded and skipped attachments.
- b5b577c: Stage 9: generalization and operations. `qajitsu init` creates `.qa/` for any repository (git host from the remote,
  compose services and ports, OpenAPI document, web/mobile test types) and validates it; `qajitsu doctor` checks secrets
  by reference, Docker, Android SDK and Appium, iOS availability and, with `--online`, Jira and code host access
  (`check()` on ticket sources and code hosts). Runs export OpenTelemetry traces (run = trace, stage = span, tool/model
  calls and case attempts = child spans), logs and metrics over OTLP/HTTP (`telemetry` section, `qajitsu telemetry
  export`). `qajitsu metrics` aggregates runs for Prometheus with example alert rules. The run journal is a SHA-256 hash
  chain (`qajitsu audit verify`, `journal-intact` publish gate) and `gc` archives journals under `audit.retention_days`.
  `pnpm docs` builds the TypeDoc site; CI runs on Linux and macOS.

### Patch Changes

- 1384f6e: Plugins installed on demand (REQ-GEN-11). `@qajitsu/core` adds `PLUGIN_API_VERSION`, `PLUGIN_TYPES`,
  `parsePluginManifest` and `PluginError`. Every adapter package now carries its plugin manifest under
  `qajitsu.plugin`. The CLI adds `qj plugin list|add|remove`, which installs the version a release pins from the npm
  registry, checked against its published checksum and without install scripts. `qj doctor` names missing plugins and
  `--fix` installs them, `qj setup` installs the plugins a project needs, runs record the plugin versions they used,
  and `qj knowledge` loads its stores and sources through the plugin loader.
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
