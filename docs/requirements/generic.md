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

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-GEN-03, REQ-CFG-01, REQ-ENV-06

Found while testing every command: `qj doctor` listed some Android lines twice, its variants did not use the same exit
codes, and it said nothing about a secrets file other users of the machine could read.

**Acceptance criteria**

- [ ] AC1: Every check and every tool appears once in the output, also when a tool is found in several places (e.g. the Android SDK through `ANDROID_HOME` and QAJitsu's toolchain); the line says which one is used.
- [ ] AC2: `doctor`, `doctor --models`, `doctor --online` and `doctor --fix` share one exit code rule: `0` no errors (information and warnings allowed), `3` at least one error; the rule is documented and tested for each variant.
- [ ] AC3: On macOS and Linux `doctor` warns when `.env.local` (or another file the env secret provider reads) can be read by the group or others, with `chmod 600 <file>` as the fix; it never prints the file's content.
