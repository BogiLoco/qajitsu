# @qajitsu/adapter-env-compose

## 0.1.0

### Minor Changes

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
- 5661a8c: Core interfaces follow the real seams (ADR-0005): `Runner` is replaced by `AttemptExecutor` with `AttemptRequest`,
  `AttemptRecord` and `EvidenceItem` now in `@qajitsu/core`; `EnvProvider.start()` returns a handle with `baseUrl`,
  `health`, `deployedSha`, `stubs` and `stop()`, implemented by `createRemoteEnvProvider` and
  `createComposeEnvProvider`; `ModelProvider` is the registry shape (`resolve`, `forRole`) that `ModelRegistry`
  extends. Every interface has a shared contract suite in `tests/contract/`.
- bcbf786: `qj run` without `--env` or `--build` uses the environment `qj env up` started for the run while it answers, as
  `qj explore` already did; it said nothing and ran every case against `environments.default`, which ended BLOCKED.
  
  `qj status` lists the environments still running for the project's runs, with their URLs and the `qj clean` command
  that stops them; detached demo environments ran unnoticed for days.
- 4a3e7b8: Starting the application from the worktree (`qj run --build`, `qj env up`) with Docker Compose or managed processes is a plugin (REQ-GEN-11/AC1): `qj plugin add env-compose`; `qj setup` installs it for a project with `build` or compose services. Cleanup and `qj status` skip container work when the plugin is not installed, because without it QAJitsu started none. The EnvProvider contract runs against the installed plugin.
- ef6861b: Stage 6: local environments, configuration and cleanup. `qajitsu run --build` starts the application from the
  run's worktree: Docker Compose with a generated overlay (project `qj-<ticket>-<suffix>`, dynamic localhost ports,
  `qajitsu.*` labels on containers, networks and volumes), managed processes with logs, WireMock/Mockoon stubs listed
  in the report, health checks and a seed hook with the run marker. Service variables are constants, templates
  (`{{svc.db.url}}`, `{{port}}`) or secret references, with `--set` overrides for overridable ones; per-service `.env`
  files are 0600 and deleted on every exit path. The configuration is validated before start (`qajitsu env check`,
  exit code 3), the masked effective configuration is recorded in `run.json`, and a start failure makes every case
  BLOCKED with the service logs as evidence. New commands: `env check`, `env render`, `runs`, `resume`, `clean`, `gc`;
  cleanup policy and retention (`cleanup` section, `--keep`); run lock files and a locked run index.

### Patch Changes

- 3ec9d51: The guard holds every plugin to its manifest (REQ-GEN-11/AC4+AC9, ADR-0015). `@qajitsu/guard` adds
  `checkPluginCode`. At install, and again before an installed plugin is loaded, the plugin's own code is checked
  against its permissions: Node's network, process and file modules, reads of `process.env` and the global `fetch`. A
  plugin that does more than it declares, or that refers to the frozen plan, is refused. Every HTTP call of an
  integration plugin goes through a guarded `fetch` that allows only its manifest's hosts and the URLs the project
  configures for it. Plugin manifests get the `environment` permission, and five manifests that understated their code
  are corrected.
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
