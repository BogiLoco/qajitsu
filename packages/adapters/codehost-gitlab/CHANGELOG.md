# @qajitsu/adapter-codehost-gitlab

## 0.1.0

### Minor Changes

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
- 2339516: GitLab.com and GitLab self-managed as a code host are a plugin (REQ-GEN-11/AC1): `qj plugin add codehost-gitlab`; `qj setup` installs it for a project with a `gitlab` code host. The adapter takes `@qajitsu/core` as a peer dependency; the CodeHost contract runs against the installed plugin.
- ea69cf8: `qj promote <TICKET>`: proposes the run's PASSED cases as a pull/merge request to the tests repository with the exact specs that passed and the approved plan's expectations, after a confirmation. Runners record each attempt's spec SHA-256 (results and journal); `CodeHost.openChangeRequest` for GitHub and GitLab; `repos.<alias>.promote_dir`.
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
