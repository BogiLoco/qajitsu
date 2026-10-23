# Generic framework and interfaces (GEN)

QAJitsu plugs into any project through configuration; differences between projects live in adapters and `.qa/`.

### REQ-GEN-01 · Project onboarding through `.qa/`

- Status: implemented
- Priority: must
- Stage: 1
- Related: REQ-CFG-01, REQ-CTX-07

**Acceptance criteria**

- [x] AC1: `.qa/qa.project.yaml` validated by a strict schema (unknown keys rejected) with clear error paths.
- [x] AC2: Folders: `envs/`, `auth/` (login helpers per alias), `hooks/` (seed, setup, teardown), `knowledge/`, `stubs/`.
- [x] AC3: No change to QAJitsu code is needed to onboard a project.

### REQ-GEN-02 · Adapter interfaces

- Status: implemented
- Priority: must
- Stage: 1
- Related: INV-12, ADR-0005

**Acceptance criteria**

- [x] AC1: Interfaces in `@qajitsu/core`: TicketSource, CodeHost, ModelProvider, EnvProvider, SecretProvider, AttemptExecutor (the runner seam, ADR-0005), EvidenceStore, Publisher.
- [x] AC2: Each adapter is a separate package selected by `type` in config through a registry.
- [x] AC3: Each interface has a shared contract test suite.

### REQ-GEN-03 · `init` and `doctor`

- Status: implemented
- Priority: must
- Stage: 9
- Related: REQ-LLM-03, REQ-CFG-04, REQ-PRJ-02, REQ-CTX-04, REQ-OBS-10

**Acceptance criteria**

- [x] AC1: `qajitsu doctor` checks Node.js and project configuration (stage 1).
- [x] AC2: `doctor` grows with stages: Jira and code host access, Docker, emulators, secrets, model capabilities.
- [x] AC3: `qajitsu init` (basic version in REQ-PRJ-02, stage 2) learns to detect `docker-compose.yml`, repos and test types when creating `.qa/`.
- [x] AC4: `doctor` prints the versions of QAJitsu, the operating system, Node.js, git, Docker and Compose, Playwright and each installed browser, Java, the Android SDK components and emulator, Appium and its drivers. A tool the project does not need is shown as information; a missing tool the project needs is an error with the command that installs it.
- [x] AC5: `doctor` shows the versions of the application under test the project knows: for each of its repositories whether the git mirror exists, when it was last updated, the commit of its default branch and the commit of the latest run; with `--online` also whether the remote has newer commits and, for each environment profile with a `version_path`, the version deployed there and whether it matches the commit of the latest run; for a mobile app, where its binary comes from (path, build or CI artifact). A mirror that cannot be read is an error with the fix (`qj clean --project`, then `qj fetch` downloads it again); an environment that does not answer is shown as unknown.

### REQ-GEN-04 · Claude Code plugin interface

- Status: implemented
- Priority: could
- Stage: 9
- Note: accepted on 2026-10-04 by the owner.
- Related: REQ-GEN-05

**Acceptance criteria**

- [x] AC1: The same core exposed as a Claude Code plugin with skills `/qa-plan`, `/qa-run`, `/qa-evidence` for chat-driven use.

### REQ-GEN-05 · Command line

- Status: implemented
- Priority: must
- Stage: 1
- Related: REQ-CI-04

The CLI `qajitsu` (alias `qj`) is the primary interface. Commands arrive with their stages.

**Acceptance criteria**

- [x] AC1: `--version`, `doctor` (stage 1).
- [x] AC2: `fetch` (1); `init`, `use`, `projects`, `plan`, `approve` (2); `run`, `test`, `env check|render|up`, `status`, `note` (3); `evidence`, `logs` (5); `runs`, `resume`, `clean`, `gc`, `work reset` (6); `bench`, `knowledge` (7); `pull` (9).
- [x] AC3: Every command documents its exit codes in `docs/cli/`.

### REQ-GEN-06 · Toolchain setup

- Status: implemented
- Priority: should
- Stage: later
- Related: REQ-GEN-03, REQ-ENV-06, REQ-EXEC-05, REQ-EXEC-06, REQ-NFR-05, REQ-NFR-07, REQ-OBS-10

Everything QAJitsu needs to run web, Android and iOS tests and `--build` is installed by one command, at versions
QAJitsu was tested with, without touching tools the user installed and without changing the user's shell.

**Acceptance criteria**

- [x] AC1: `qj setup` reads what the project needs from `.qa/` (web browsers of the matrix, Docker for compose services, Java, the Android SDK, platform, build tools, emulator, system image and AVD, Appium and its drivers, Xcode for local iOS) and installs only what is missing, at the versions pinned in QAJitsu's toolchain manifest; `.qa/toolchain.yaml` can pin other versions for a project.
- [x] AC2: A tool already present at a compatible version is used as it is; one present at an incompatible version is never changed or removed: `qj doctor` reports it with the compatible range and how to fix it, and `qj setup` can install a compatible version next to it.
- [x] AC3: Tools QAJitsu installs live in `~/.qajitsu/toolchain/` (one copy per version, shared by every project), with a record of what was installed, from where, with which checksum and licence; QAJitsu passes them to the processes it starts (`JAVA_HOME`, `ANDROID_HOME`, `ANDROID_AVD_HOME`, `APPIUM_HOME`) and never edits shell profiles. Docker and Xcode are system-wide: installed once (Colima with the Compose plugin on macOS, Docker Engine on Linux, Xcode through `xcodes`), never removed by QAJitsu.
- [x] AC4: `qj setup --check` prints the plan (what, which version, from where, how big) without changing anything, also as `--json`; `--only` and `--skip` choose parts; `--yes` runs without questions and accepts the Android SDK licences on the user's behalf, listing them; without `--yes` the licences and every download over 100 MB are confirmed first.
- [x] AC5: `qj setup --reinstall <tool>`, `--uninstall <tool>` and `--uninstall --all` change only what QAJitsu installed (by its record); `--version <tool>=<version>` installs another version next to the current one.
- [x] AC6: Before downloading, setup checks the processor architecture (picks arm64 or x86_64 images), hardware virtualisation for the emulator (HVF, KVM), free disk space and memory, and stops with the reason when the emulator cannot run here (pointing to a device farm). Downloads are resumable, verified against published checksums before they are used, installed atomically, and two setups cannot run at once.
- [x] AC7: Sources can be private mirrors (npm registry with a `secret://` token, Playwright download host, Java and Android mirrors, Homebrew), through a proxy and with a company CA certificate, configured per machine or per project; `qj doctor --online` checks they answer. `qj setup --download <dir>` collects everything for an offline machine and `qj setup --from <dir>` installs from it.
- [x] AC8: After installing, a smoke test proves the tools work (Java runs, the SDK lists its packages, the emulator's acceleration check passes, Appium lists its drivers, the browser starts); `--smoke` also boots the emulator once. A failure names the tool and the next step; nothing is reported ready that did not pass.
- [x] AC9: `qj doctor --fix` runs `qj setup` for what `qj doctor` found missing; tools' own usage analytics (Homebrew, Appium) are switched off in the processes QAJitsu starts.

### REQ-GEN-07 · External agent mode: Claude Code subagents do the agents' work

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-GEN-04, REQ-PLAN-04, REQ-PLAN-07, REQ-PLAN-09, REQ-EXEC-03, REQ-EXEC-09, REQ-LLM-02, REQ-PLAN-10, ADR-0003, ADR-0009, INV-1, INV-2, INV-3, INV-4
- Note: TO BE REVIEWED (owner, 2026-10-16): the idea is agreed, the design is not; think it through before accepting (protection without the guard while Claude Code runs, how drafts reach QAJitsu, how the run shows an external agent wrote them).

A tester works in their own Claude Code session (their subscription) and lets its subagents, each on its own model,
write the analysis, the plan, the specs and the heals. QAJitsu calls no model: it checks every draft with the same
code as its own agents' output, executes, and computes the verdict. A person still approves the plan.

**Acceptance criteria**

- [ ] AC1: The plugin ships subagents `qa-analyst`, `qa-planner`, `qa-author` and `qa-healer`, each with its own model setting, that write drafts into the run's `drafts/` folder only.
- [ ] AC2: `qj plan <TICKET> --draft <dir>` takes the analysis and plan drafts instead of calling models and applies every check of planning (schema, verbatim sources, plan quality, snapshot); problems are printed for the subagent to fix, and a clean draft becomes the next plan version for review.
- [ ] AC3: `qj run <TICKET> --no-author` calls no model: cases without a spec are BLOCKED with the reason, and every spec passes the static checks, assertion lock and plan coverage as today; `qj heal <TICKET> --case <id> --draft <file>` accepts a healed spec only through the assertion-lock diff, and a healed case is never PASSED.
- [ ] AC4: Plugin hooks deny Claude Code writes to `results/`, `evidence/`, `plan/plan.approved.yaml`, `run.json`, `checks/`, `manual/` and `journal/`, and deny running `qj approve`, `qj answer` and `qj publish` from the session.
- [ ] AC5: `qj approve` refuses to run inside an agent session (Claude Code's environment) and asks the person in their own terminal; approval stays human as in REQ-PLAN-07/AC4.
- [ ] AC6: Every draft taken is journaled with its SHA-256 and the run records that its drafts came from an external agent; hashes and publish gates catch any change to results, evidence, checks or the approved plan, whatever wrote it.

### REQ-GEN-08 · Consistent `doctor` output and exit codes

- Status: implemented
- Priority: should
- Stage: later
- Related: REQ-GEN-03, REQ-CFG-01, REQ-ENV-06

- Note: accepted by the owner on 2026-10-21 with AC2 made precise (a model check fails only on models) and implemented.

Found while testing every command: `qj doctor` listed a missing Android SDK, emulator and Appium two or three times,
`doctor --models` failed on a missing Android SDK although every model answered, and it said nothing about a secrets
file other users of the machine could read.

**Acceptance criteria**

- [x] AC1: A missing tool is an error once, with the command that installs it: a check that already reports it (the Android SDK for its emulator, Appium for its drivers, Docker for Compose) is not repeated by another check, and the versions table points at that check instead of repeating the error.
- [x] AC2: `doctor --models` checks only Node.js, the project config and the models (every role's and the approval flow's model), so tooling a model check does not need cannot fail it; combined with `--online` or `--fix` it is refused with how to run them. Every variant uses one exit code rule: `0` no errors (information and warnings allowed), `3` at least one error; documented and tested.
- [x] AC3: On macOS and Linux `doctor` warns when `.env.local` (or another file the env secret provider reads) can be read by the group or others, with `chmod 600 <file>` as the fix; it never prints the file's content.

### REQ-GEN-09 · Signed release images

- Status: proposed
- Priority: should
- Stage: 3
- Related: REQ-CI-01, REQ-NFR-05

REQ-CI-01 already ships a Docker image for other CI systems; this makes the release images verifiable.

**Acceptance criteria**

- [ ] AC1: Official QAJitsu images are published from CI to a public registry for every release.
- [ ] AC2: Images are built for amd64 and arm64.
- [ ] AC3: Every image is signed and ships with an SBOM and build provenance that a user can check.
- [ ] AC4: Tags follow releases (exact version, minor and `latest`); runs record the image digest, never only a tag.
- [ ] AC5: The quick start in the documentation runs the demo-shop flow with one container command and no other installation.
- [ ] AC6: Images run as a non-root user and contain no secrets; configuration and secrets come only from mounted config or the secret provider.

### REQ-GEN-10 · Ready-to-run images and a Compose stack

- Status: proposed
- Priority: should
- Stage: 9
- Related: REQ-GEN-06, REQ-GEN-09, REQ-CI-01, REQ-CI-06, REQ-LLM-05, REQ-KNOW-08

Pull and run instead of installing: images on a public registry and one Compose file that brings up QAJitsu with the
chosen models. The images are built with `qj setup` (REQ-GEN-06), so the tool versions have one source; installing
on the machine stays the other way.

**Acceptance criteria**

- [ ] AC1: Every release publishes images from CI to Docker Hub and GHCR: `qajitsu` (API and web: Node.js, git, browsers) and `qajitsu-android` (plus Java, Android SDK, emulator and Appium), built with `qj setup` at QAJitsu's pinned versions; the Dockerfiles of `ci/docker` are their source.
- [ ] AC2: `qj stack init` writes a `compose.yaml` for the project: QAJitsu, Ollama and, when the knowledge base uses it, Chroma; parameters (preset, models per role, GPU, ports, volumes) come from options or a short questionnaire.
- [ ] AC3: The models named for the roles are pulled into Ollama once, at the first start, by a step of the stack; `models.roles` of the project is written to match, and the stack fails with the model name when a pull fails.
- [ ] AC4: Images, model names and their digests are pinned in the generated file and recorded with every run (REQ-OBS-10).
- [ ] AC5: No secret is baked into an image or written into `compose.yaml`; secrets come from `.env.local` or the secret provider at run time.
- [ ] AC6: The stack runs with Docker Engine and Podman; GPU access for Ollama is optional and documented per platform; the Android image states that the emulator needs KVM.

### REQ-GEN-11 · Integrations as plugins, installed on demand

- Status: proposed
- Priority: should
- Stage: 9
- Related: REQ-GEN-02, REQ-GEN-03, REQ-GEN-06, REQ-NFR-05, ADR-0011, INV-12

Integrations stay in this repository, but an installation carries only what a project uses. Today `@qajitsu/cli`
depends on all twenty adapter packages, so everyone installs every integration (LanceDB alone is about 230 MB).

**Acceptance criteria**

- [ ] AC1: The core installation carries the core adapters only: Jira, GitHub, GitLab, local repositories, the API and web runners, secrets from the environment and local evidence. Every other integration (for example Xray, Zephyr, TestRail, Vault, Doppler, Confluence, Chroma, LanceDB, the mobile runner, webhook.site) is a plugin package published from this repository.
- [ ] AC2: `qj doctor` reads the project configuration and names every plugin it needs and lacks (for example `test_cases: { type: xray }` without the Xray plugin) with the command that installs it; a command that needs a missing plugin stops with the same message instead of a module error.
- [ ] AC3: `qj setup` and `qj doctor --fix` install the plugins the project needs into the QAJitsu home at versions pinned for the QAJitsu release, checked against their published checksums, without install scripts; `qj plugin list|add|remove` shows and changes them by hand.
- [ ] AC4: A plugin works only through the adapter interfaces of `@qajitsu/core` (INV-12): it cannot replace the guard, the verifier, status computation, masking or publish gates, and it gets secrets only through the secret provider.
- [ ] AC5: The plugins and versions a run used are recorded with the run (REQ-OBS-10).
- [ ] AC6: Offline installations take plugins from the offline bundle of `qj setup --download` (REQ-GEN-06).
- [ ] AC7: Each plugin has a manifest: name, version, plugin type (ticket source, test-case source, publisher, runner, environment provider, secret provider, tool), the range of the core's adapter API it works with, required secrets, network hosts and permissions.
- [ ] AC8: A plugin whose core API range does not match is refused with a clear message.
- [ ] AC9: A plugin reaches the network only to the hosts in its manifest that are also on the environment allowlist, and never writes results, evidence or the frozen plan; the guard enforces it like for agents.

### REQ-GEN-12 · Plugin tiers, dev kit and registry

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-GEN-11, REQ-NFR-05, REQ-NFR-06, ADR-0011, INV-1, INV-8

Plugins from QAJitsu, from partners and from the community, free or paid, through one mechanism that never weakens
what makes the results trustworthy.

**Acceptance criteria**

- [ ] AC1: Every plugin has a tier shown wherever it is listed: official open source (Apache-2.0, this repository), official commercial (QAJitsu's own licence), partner, or community.
- [ ] AC2: A commercial plugin needs a licence key from the secret provider; the key is checked offline against a signature in the key, so a run never depends on a licence server; an expired or missing licence stops only the commands that use that plugin, with the reason.
- [ ] AC3: A plugin dev kit (`create-qajitsu-plugin`) gives a template, the adapter interfaces, contract tests every plugin must pass and an adversarial suite for plugins that touch statuses, evidence or secrets.
- [ ] AC4: The registry lists plugins with tier, publisher, versions, licence, checksum and signature; `qj plugin add` installs only signed plugins whose publisher the installation trusts, and community plugins only after an explicit confirmation.
- [ ] AC5: No tier changes the invariants: a paid or partner plugin cannot set or upgrade a status (INV-1), see unmasked secrets (INV-8) or skip the guard; the contract tests check it.
- [ ] AC6: The open-source core stays complete for the flow from ticket to published result; commercial plugins add integrations and features, never a missing piece of that flow.
- [ ] AC7: A plugin is marked "verified" in the registry only after it passed the dev kit's contract tests in CI and a review of its manifest.
- [ ] AC8: Adapter interfaces follow semantic versioning; a breaking change gets a new major version and a documented transition period.
- [ ] AC9: A template repository and the `/new-adapter` guide describe how to build, test and publish a plugin.

### REQ-GEN-13 · Doctor recommends what to install from the application

- Status: accepted
- Priority: should
- Stage: later
- Related: REQ-GEN-03, REQ-GEN-06, REQ-PRJ-02, REQ-LLM-01, INV-11

Installing every tool "just in case" costs gigabytes and time. QAJitsu looks at the application and proposes only what its tests need.

**Acceptance criteria**

- [ ] AC1: `qj doctor --recommend` detects by code from the repositories what the application is and how it can be tested: web front-ends, mobile projects (Gradle, Xcode, React Native, Flutter), API descriptions (OpenAPI, GraphQL SDL, `.proto`, WSDL, AsyncAPI), compose files and existing test suites (Playwright, Appium, Maestro).
- [ ] AC2: An agent turns the findings into a recommendation of tools and `.qa` settings (browsers, Docker, Java and the Android SDK or not, Xcode or a farm, Appium or Maestro, runners per API type), each with the files it is based on; every cited file and finding is checked by code, and a recommendation without a found basis is dropped.
- [ ] AC3: The recommendation lists what will not be installed and why, the download size and disk space of each tool, and the command for it (`qj setup --only ...`).
- [ ] AC4: Nothing is installed or changed without the user's confirmation; with `--yes` in CI only the recommended set is installed.
- [ ] AC5: Without a model (offline) the deterministic findings still give a recommendation, marked as such.
- [ ] AC6: Repository content is untrusted data: it can never make the agent recommend tools outside QAJitsu's toolchain manifest or sources outside the configured mirrors.
