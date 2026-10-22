# Command reference

Every `qajitsu` (alias `qj`) command with its options and exit codes. The guides in this folder explain the flow
([fetch](fetch.md), [plan](plan.md), [run](run.md), [publish](publish.md), [build and runs](build-and-runs.md),
[web and observability](web-and-observability.md)); this page is the complete list. A contract test
(`tests/contract/cli-docs.test.ts`) fails when a command or option exists in the code but not here, or the other way round.

Exit codes follow one scheme (REQ-CI-04):

| Code | Meaning                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------- |
| `0`  | success; for commands that report test results: every case PASSED                                         |
| `1`  | at least one case FAILED (or, for `audit verify`, a broken journal; for `audit trail` and `export`, gaps) |
| `2`  | nothing failed, but not everything passed or the command stopped at a human decision                      |
| `3`  | configuration or framework error: nothing was decided, fix the setup and run the command again            |

`--help` on any command prints its options; `--version` prints the version.

Every command except `init`, `use` and `projects` runs in a project (ADR-0006), resolved in this order: `--project
<slug>` (before the command, e.g. `qj --project bank fetch BANK-12`), `QAJITSU_PROJECT`, the Jira key prefix of the
ticket, the active project. The first output line names it (`Project: bank (ticket prefix BANK)`); without a project
the command stops with exit code 3.

## Setup

### `qajitsu init <slug>`

Registers a project (REQ-PRJ-02, ADR-0006): creates its home `~/.qajitsu/projects/<slug>/` (runs, git cache,
knowledge, exports, logs), links the repository's `.qa/` folder or creates one from what the repository contains
(git host, compose services, OpenAPI, test types), validates it and reports every problem, and makes it the active
project. Running it again changes nothing without `--force`; runs and knowledge are never deleted.

- `--qa-dir <path>`: the project's `.qa/` folder (default `./.qa`)
- `--jira-prefix <KEY>`: Jira key prefix that selects this project, e.g. `BANK` (repeatable; default the configured
  `jira.project_key`)
- `--yes`: do not ask; use detected values and flags
- `--force`: relink an existing project
- `--no-use`: do not make it the active project
- `--jira-url <url>`, `--project-key <key>`, `--env-url <url>`: answers when `.qa/` is created

When `.qa/` is created, `init` looks for provider keys by their names in the environment and in `.env.local`
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`); values
are never read into the output (REQ-LLM-09). With an Anthropic, OpenAI or Google key it proposes a model for every role
and a cheaper one with vision as the auditor (`anthropic/claude-sonnet-5-5` and `claude-haiku-5-5`,
`openai/gpt-6.1-sol` and `gpt-6-luna`, `google/gemini-4-argon` and `gemini-3.8-flash`), asks for a spending limit per run (default $5,
`budget.max_cost_usd`) and writes both after a yes (`--yes` accepts). Other keys are named with what to set by hand.

Exit codes: `0` registered and ready, `2` registered but not ready (the problems are listed), `3` errors.

### `qajitsu use <slug>`

Makes a project the active one and shows its open work (REQ-PRJ-03).

Exit codes: `0` switched, `3` unknown project.

### `qajitsu projects list` (also `qajitsu projects`)

Every registered project with readiness, ticket prefixes, open work and its `.qa/` folder; `*` marks the active one.

- `--archived`: include archived projects (marked `archived`)

Exit codes: `0` listed, `3` errors.

### `qajitsu projects remove <slug>`

Deletes a project's home (runs, caches, knowledge base, exports, logs) after listing what goes and its size
(REQ-PRJ-07/AC3+AC4). Containers, worktrees and locks of every run are cleaned first; run journals are archived to
`<QAJITSU_HOME>/audit/<slug>/`; the project's `.qa/` folder in its repository is never touched. Without `--yes` it
asks to type the slug; non-interactively it refuses.

- `--dry-run`: only list what would be deleted and its size
- `--yes`: do not ask for confirmation
- `--delete-audit`: also delete the archived run journals

Exit codes: `0` removed or listed, `3` refused or errors.

### `qajitsu projects export <slug>`

Writes the project profile to one YAML file: slug and Jira prefixes, the text files of its `.qa/` folder and its
knowledge sources (REQ-PRJ-09/AC1). Never the knowledge index, runs, `.env` files, keys or certificates; refused when
any `.qa/` file holds a secret value of the project or something that looks like a credential.

- `--out <file>`: where to write it (default: `<project-home>/exports/<slug>.profile.yaml`)

Exit codes: `0` written, `3` refused or errors.

### `qajitsu projects import <file>`

Recreates a project from a profile on another machine (REQ-PRJ-09/AC2): an existing `.qa/` at the target is linked,
otherwise the profile's `.qa/` files are written there; knowledge sources are registered and rebuilt with
`qajitsu knowledge sync`. Secrets go into `.env.local` or the secret manager afterwards.

- `--qa-dir <path>`: where the project's `.qa/` folder is or goes (default: the exported path)
- `--slug <slug>`: register under another name
- `--map-path <old=new>`: rewrite a path prefix of `.qa/` and knowledge sources (repeatable)
- `--force`: replace an existing project with that name (runs and knowledge stay)

Exit codes: `0` imported, `2` imported but some knowledge sources are missing, `3` errors.

### `qajitsu projects archive <slug>`

Hides a project from `projects list`, `status --all` and ticket prefix mapping (REQ-PRJ-07/AC5). Nothing is deleted;
an archived active project stops being active.

Exit codes: `0` archived, `3` unknown project.

### `qajitsu projects unarchive <slug>`

Shows an archived project again in lists and ticket prefix mapping.

Exit codes: `0` restored, `3` unknown project.

### `qajitsu projects current`

Prints the active project.

Exit codes: `0` printed, `3` no active project.

### `qajitsu doctor`

Checks Node.js, the project configuration, secrets, Docker and mobile tooling.

It ends with two sections (REQ-GEN-03/AC4+AC5). **Versions**: QAJitsu, the operating system, Node.js, git, Docker
and Compose, Playwright and each browser, Java, the Android SDK, emulator, Appium and its drivers; ✔ found, ✘ missing
and needed by this project (an error, with the install command), · missing and not needed. **Application under
test**: for each repository whether its git mirror exists, when it was last updated, the commit of its default branch
and of the latest run (an unreadable mirror is an error with the fix); with `--online` also the commit on the remote
and, for each environment profile with a `version_path`, the deployed version compared with the latest run; and where
the mobile app binary comes from.

A third section, **Toolchain (qj setup)**, shows what `qj setup` would do for every tool the project needs (REQ-GEN-06/AC2):
use yours, use QAJitsu's, install (with version, size and source), start Docker, or what you have to do. A tool of
yours that is not compatible is information (`!`), with the compatible range and the fix; it is never changed.

- `--models`: probe the configured model of every role and the model of the approval flow, which must be another
  model than the planner's (makes real model calls);
  only Node.js, the project config and the models are checked then, so a missing Android SDK does not fail it; it
  cannot be combined with `--online` or `--fix`
- `--online`: check access to Jira, every code host and every toolchain source (npm registry, Playwright host, Java and
  Android mirrors, Homebrew; makes real requests)
- `--fix`: run `qj setup --only <the tools found missing>` (REQ-GEN-06/AC9)
- `--yes`: with `--fix`, no questions; licences are accepted on your behalf and listed

A missing tool is reported once: when a check already reports it (the Android SDK for its emulator, Appium for its
drivers, Docker for Compose), the versions table says `see android above` instead of repeating it. A `.env.local`
other users of the machine can read is a warning (`!`) with `chmod 600 <file>` as the fix; its content is never
printed (REQ-GEN-08).

Exit codes: `0` every check passed (warnings allowed), `3` at least one check failed (after `--fix`: `0` when setup succeeded and every
other check passed).

### `qajitsu setup`

Installs what the project needs, at the versions QAJitsu is tested with (REQ-GEN-06): the browsers of the web matrix,
Docker with Compose for compose services, Java (Eclipse Temurin 17.0.20.1+1) and the Android SDK packages (platform
tools; platform and build tools for `app.source: build`; emulator, system image and AVD for a configured emulator),
Appium 3.8.0 with UiAutomator2 8.7.0 / XCUITest 12.16.0 when QAJitsu starts Appium, and Xcode for local iOS.

A tool already on the machine at a compatible version is used as it is; an incompatible one is never changed, a
compatible copy is installed next to it. Managed tools go to `~/.qajitsu/toolchain/<tool>/<version>/` with a record
(`installed.json`: source, checksum, licence, smoke test); the project's choice is written to
`~/.qajitsu/projects/<slug>/toolchain.json` and passed to every process QAJitsu starts (`JAVA_HOME`, `ANDROID_HOME`,
`ANDROID_SDK_ROOT`, `ANDROID_AVD_HOME`, `APPIUM_HOME`, `PATH`). Shell profiles are never edited. Docker (Colima, the
Docker CLI and the Compose plugin from Homebrew on macOS; `docker.io` and `docker-compose-v2` through apt on Linux) and
Xcode (`xcodes`, needs your Apple ID) are system-wide: installed once, never removed by QAJitsu.

Before anything is downloaded: processor (arm64-v8a or x86_64 system images; an image for the other one is refused;
Linux on ARM64 has no Android emulator build),
hardware virtualisation (HVF on macOS, `/dev/kvm` on Linux), memory (4 GiB minimum for the emulator), free disk, curl,
tar and unzip. A failed check stops setup with the reason; `--skip` the tool to set up the rest. Downloads resume from
a partial file, are verified against the publisher's checksum (Adoptium SHA-256, Google SHA-1) before use and are moved
into place only when complete. A lock (`~/.qajitsu/toolchain/.setup.lock`) keeps two setups apart.

After installing, every tool is smoke-tested; nothing that failed is reported ready.

- `--check`: print the plan (what, which version, from where, how big) and the prechecks; change nothing
- `--json`: the plan or the result as JSON (the project line goes to stderr)
- `--only <tools>`, `--skip <tools>`: comma-separated, repeatable; tools are `browsers`, `docker`, `java`, `android`,
  `appium`, `uiautomator2`, `xcuitest`, `xcode`. Without a project nothing is needed: name the tools with `--only`.
- `--yes`: no questions; the Android SDK licences (and with Xcode, its licence) are accepted on your behalf and listed.
  Without `--yes` the licences and every download over 100 MB are confirmed first; without a terminal setup stops.
- `--reinstall <tool>`: install again what QAJitsu installed (repeatable)
- `--uninstall <tool>`: remove what QAJitsu installed of that tool, by its record; never Docker or Xcode, never a
  path outside `~/.qajitsu/toolchain/`
- `--all`: with `--uninstall`, everything QAJitsu installed and its download cache
- `--version <tool>=<version>`: install another version next to the current one: `java=21` (latest Temurin 21 with its
  published checksum), `appium=3.7.0`, `uiautomator2=8.6.0`, `xcuitest=…`, `xcode=16.4`. Browser versions are those of
  QAJitsu's Playwright.
- `--download <dir>`: install every managed tool the project needs into `<dir>` (also when this machine has them) and
  write `bundle.json` with a digest of every folder
- `--from <dir>`: install from such a bundle without network: same system and processor only, every folder checked
  against its digest, AVDs created on this machine, smoke-tested
- `--smoke`: also boot the emulator once
- `--ignore-check <check>`: do not stop on this precheck (`virtualisation`, `memory`, `disk`, `system image`;
  repeatable). It is still printed, marked as ignored. Meant for building an image on a machine without KVM for hosts
  that have it: with `virtualisation` ignored the smoke test does not check the emulator's acceleration.

`.qa/toolchain.yaml` (per project) and `~/.qajitsu/toolchain.yaml` (per machine; the project wins key by key):
`versions` (`java`, `android.platform`, `android.build_tools`, `appium`, `uiautomator2`, `xcuitest`, `xcode`),
`sources` (`npm_registry`, `npm_token: secret://…`, `playwright_host`, `java_mirror`, `android_mirror`,
`homebrew_bottle_domain`, `homebrew_api_domain`), `network` (`proxy`, `no_proxy`, `ca_certs`: added to the public roots
for curl and npm, to `NODE_EXTRA_CA_CERTS`, and to the trust store of QAJitsu's Java).

Exit codes: `0` everything wanted is ready, `1` a tool failed or needs a manual step (the line names the next step),
`2` setup stopped before changing anything (a precheck, a declined licence, a wrong flag).

## The flow

### `qajitsu test <ticket>`

The whole flow in one command: `fetch`, `plan` with the interactive review, `run`, and `publish` after the preview.
It stops at the human decisions: an unapproved plan stops before anything runs, a declined preview publishes nothing.

- `--pr <url>`, `--mr <url>`, `--ref <[repo=]ref>`: as for `fetch`
- `--env <profile|url>`, `--build`, `--keep`, `--set <service.VAR=value>`: as for `run`
- `--dry-run`: stop after the run; do not publish

Exit codes: the code of `run` (`0`, `1`, `2`); `2` when the plan was not approved; `3` when a stage failed.

### `qajitsu fetch <ticket>`

Fetches the ticket, its PRs/MRs, diffs and the repositories at the change's commit into a new run folder.
With `test_cases:` in the project configuration it also imports the manual test cases linked to the ticket (Xray
Cloud, Zephyr Scale, TestRail, CSV/Excel) into `imported/cases.json` (REQ-CTX-08); a source that fails is reported as a
warning and in the journal, and fetching continues without it.

- `--pr <url>`: use this GitHub pull request (repeatable)
- `--mr <url>`: use this GitLab merge request (repeatable)
- `--ref <[repo=]ref>`: use this branch, tag or SHA (repeatable)

Exit codes: `0` fetched, `3` configuration, access or ticket errors.

With `code: { access: metadata }` in the project config only the description of each change is kept (title,
description, changed file names in `repos/<repo>.meta.json`); no repository is checked out and no diff or review
comment is stored. With `access: none` nothing is read from the code hosts. The tests repository (`role: tests`) is
fetched in every mode. Commands that need the code (`--build`, `--fix-check`) say so (REQ-CTX-10).

### `qajitsu plan <ticket>`

Analyses the fetched change and writes a plan version; in a terminal, the review loop accepts, revises or edits it.
When the project has earlier runs, the application map around the change (`map/around.json`: touched, never tested
and last failed screens, endpoints and transitions) is given to the planner, which may add regression cases citing it
(REQ-OBS-08); a map that cannot be built is a warning and planning continues.

The planner and the author also get the element ids (`data-testid`, `testID`, Android content descriptions, …) and
page paths that code finds in the run's worktree (REQ-PLAN-09/AC7). Before a plan version is shown, code checks every
expectation (REQ-PLAN-09): placeholders instead of values (`expected_total`, `<total>`, TBD), fields that are not in
the OpenAPI response of the step's call or have another type, steps with a description only, and `testid:` selectors
the code does not define. A draft with findings goes back to the planner once; what is still flagged is listed under
"Cannot be checked as written" and approving it needs a separate `yes`.

When the run has no code of the application (only a test environment), code opens the environment's start page in a
headless browser as the first account alias of the profile, follows links on the same origin (up to 12 pages) and
gives the planner what each page shows, with the selectors that find each element (REQ-EXEC-22/AC7). The pages are
saved in `ui/snapshot.json` of the run, masked; an expectation naming an element no recorded page shows is flagged
like an unknown selector (AC8). An environment that cannot be reached is reported and planning goes on without it.

- `--run <id>`: run id (default: latest run of the ticket)
- `--revise <instruction>`: write a new plan version following this instruction
- `--depth <depth>`: `smoke` (high-risk cases), `standard` (high and medium) or `full` (every case, the default).
  The planner rates every case's risk as its priority; code keeps the cases of the depth and records in the plan
  why each one is in or out (REQ-PLAN-08). The depth is remembered for revisions of the run.
- `--env <profile|url>`: environment whose pages are recorded for the planner (default: `environments.default`)
- `--snapshot`: record the environment's pages also when the code is available, or record them again
- `--build`: start the environment from the run's worktree (and the mobile devices, building the app when configured)
  only to record the pages and the app's first screen for the planner, then stop them (REQ-EXEC-22/AC9). Use it
  when the application is built per run, so the plan expects the texts the application really shows.

Exit codes: `0` plan written (and approved, if accepted in the review), `2` token budget exceeded, `3` errors.

### `qajitsu approve <ticket>`

Approves and freezes a plan version without the interactive loop (SHA-256 in `run.json`), e.g. in CI.

- `--run <id>`: run id (default: latest run of the ticket)
- `--version <n>`: plan version (default: latest)
- `--confirm-open-questions`: approve although the plan has open questions
- `--confirm-placeholders`: approve although code flags expectations it cannot check (REQ-PLAN-09/AC4); the flags
  and who confirmed them are recorded in `run.json`
- `--approver <name>`: who approves (CI: the reviewer or the `/qa approve` author)
- `--reuse-from <run>`: reuse the plan approved in this earlier run if the ticket did not change
- `--person`: a person approves now, in place of the model steps of the approval flow (REQ-PLAN-10)
- `--confirm-uncovered`: approve although no case covers some acceptance criteria or changed endpoints (REQ-PLAN-14);
  the items and who confirmed them are recorded in `run.json`

With `approval.flow` in the project config, model steps check the plan first (see [plan.md](plan.md#approval-flow-with-model-approvers-req-plan-10-adr-0010)).

Exit codes: `0` approved, `2` a model step asked for a revision or a person must decide, `3` not approvable (ungrounded sources, open questions, expectations that cannot be checked,
changed ticket) or errors.

### `qajitsu run <ticket>`

Executes the approved plan: the author writes specs, static checks run, the sandbox executes them, code computes
statuses, gates, auditor and canary run, reports are written.

Before the author writes a spec, code records what the running application shows (REQ-EXEC-22): each web case's pages
opened as the case's account in a headless browser, and the first screen of the native app on the run's device
(started before the author and reused by the mobile lane). The author gets every element with the selectors that find
it, as untrusted data; a selector the author writes that matches nothing recorded and no element id of the code goes
back to it once with the closest recorded ones. A failed web or mobile attempt keeps `failure-elements.json` (what the
page or screen showed, masked), which the healer gets; mobile cases are healed too and a healed case is never PASSED.

- `--run <id>`: run id (default: latest run of the ticket)
- `--env <profile|url>`: environment profile from `.qa/envs` or a URL (default: the environment `qajitsu env up`
  started for this run while it answers, else `environments.default`)
- `--build`: build the application from the fetched worktrees
- `--keep`: with `--build`, keep containers and worktrees after the run
- `--set <service.VAR=value>`: with `--build`, override an overridable service variable (repeatable)
- `--cases <ids>`: run only these cases of the approved plan, e.g. `TC-02,TC-03`; an id not in the plan is refused, the
  other cases are NOT_RUN ("not selected") and get no spec written (REQ-EXEC-16)
- `--headed`: show the browser of web cases and the emulator window of mobile cases; needs a display
- `--slow-mo <ms>`: wait this long (0–10000 ms) before every browser action
- `--step`: in a terminal, pause before every step with its action and expected result: Enter runs it, `c` runs the
  rest without stopping, `q` stops the case (BLOCKED, also in its retries); paused time does not count toward the
  case's time limit
- `--sequential`: one case at a time in plan order, across the API, web and mobile lanes and every device
  (REQ-EXEC-19/AC2); also `execution.sequential: true`. Without it the lanes run at the same time: API cases
  (`execution.workers.api`), web cases (`execution.workers.web`, with `execution.web_combinations` browser combinations
  at once) and mobile cases on every device; each case holds its own pool accounts while it runs (REQ-ENV-09)
- `--fix-check`: with `--build`, verify a bug fix (REQ-VER-11): after this run, a sibling run builds the commit the
  change branched from and runs the same approved plan and specs; every case marked `reproduces` must be FAILED before
  the fix and PASSED with it. Both results appear side by side in the report and the Jira comment.

With `--fix-check` the exit code is the run's when the fix is verified, `1` when a reproduction case still fails
with the fix, `2` when the check is not conclusive (e.g. the test passes before the fix) and `3` on errors.

Exit codes: `0` every case PASSED and the publish gates hold, `1` any case FAILED, `2` otherwise (BLOCKED, FLAKY,
NOT_RUN, NEEDS_REVIEW, failed gates), `3` configuration or framework errors. Ctrl+C stops the environment and exits
with `130`.

### `qajitsu publish <ticket>`

Publishes the results comment and attachments to the ticket after a confirmed preview.

- `--run <id>`: run id (default: latest run of the ticket)
- `--auto-publish`: skip the preview (CI); recorded in `run.json`

Exit codes: `0` published, `2` preview declined, `3` refused by the gates or failed.

### `qajitsu answer <ticket> <case> <step>`

Answers a manual step that a running `qajitsu run` waits for (REQ-EXEC-11, ADR-0008): in CI, or from another
terminal. Manual steps are plan steps marked `manual: true` with instructions; at such a step the run shows the
instructions and asks in the terminal, or writes `<run>/manual/<TC>.<S>.pending.json` and waits up to
`manual.timeout_s`. The answer is recorded as an assertion with `source: manual`, who and when; a failed answer
makes the case FAILED, no answer makes it BLOCKED. Notes are masked, one-time codes included.

- `--run <id>`: run id (default: latest run of the ticket)
- `--passed`: the step behaved as the plan expects
- `--failed`: the step did not behave as the plan expects
- `--note <text>`: what you observed (codes and secrets are masked)
- `--file <path>`: a screenshot or file to attach as evidence

Exit codes: `0` answered, `3` no step waiting, not exactly one of `--passed`/`--failed`, or errors.

### `qajitsu baseline accept <ticket>`

Makes screenshots of a run the approved visual baselines in `.qa/baselines/` (REQ-EXEC-12). A step with
`expect.visual` compares its screenshot (changing regions masked) with the baseline of its case, step, name and
browser/viewport/locale: above the threshold the case is FAILED with baseline, screenshot and diff as evidence;
without a baseline it is NEEDS_REVIEW and the screenshot is proposed. By default this command accepts the proposed
screenshots; `--include-failed` also accepts changed ones (an intended design change). Every screenshot is checked
against the evidence manifest first. Agents and the healer can never change a baseline.

- `--run <id>`: run id (default: latest run of the ticket)
- `--cases <ids>`: comma-separated case ids (default: every case)
- `--include-failed`: also accept screenshots that differ from their baseline (an intended change)
- `--yes`: do not ask for confirmation

Exit codes: `0` accepted (or nothing to accept), `2` not confirmed, `3` a screenshot does not match the manifest, or
errors.

### `qajitsu bug <ticket>`

Reports FAILED cases as bugs in Jira (REQ-PUB-07). Statuses and gates are computed exactly as for `publish`. For each
case it first searches for similar open bugs (same project and components, words from the case title and the failed
field) and shows them; then you create a new bug, link the failure to an existing one, or skip. The report is
written by code: steps from the approved plan with what the runner recorded, expected values from the plan and
actual values from the runner, the tested environment and commits, the browser, evidence files by SHA-256, the
failure hint (labelled as a suggestion) and the command to reproduce. Everything is masked and scanned for secrets.
A new bug is labelled `qajitsu` and linked to the tested ticket; the run records which bug belongs to which case, so a
case is never reported twice. With `jira.type: file` bugs are written to `<run>/report/bugs/`.

- `--run <id>`: run id (default: latest run of the ticket)
- `--cases <ids>`: comma-separated FAILED case ids (default: every FAILED case)
- `--link <key>`: link the failure to this existing bug instead of creating one (one case)
- `--yes`: create without asking when no similar open bug is found
- `--force-new`: with `--yes`, create even when similar open bugs exist

Exit codes: `0` done, `2` nothing created (declined, or similar bugs exist without `--force-new`), `3` refused or
errors.

### `qajitsu promote <ticket>`

Proposes the run's PASSED cases as a pull/merge request to the project's tests repository (`repos.<alias>.role:
tests`), so the work on a ticket becomes regression tests (REQ-PUB-08, REQ-CTX-06/AC4). Statuses and gates are
computed exactly as for `publish`; only PASSED cases are promoted, and only when their spec is byte for byte the one
that passed (hash recorded by the runner and in the journal). The pack in `<promote_dir>/<TICKET>/` holds the
unchanged specs as `<TC>.qajitsu.ts`, `expectations.yaml` (the approved plan's cases, its SHA-256, approver and run)
and a README; it is scanned for secrets. The branch is `qajitsu/<ticket>-<run-id>`; nothing is pushed without
confirmation.

- `--run <id>`: run id (default: latest run of the ticket)
- `--cases <ids>`: comma-separated case ids, e.g. `TC-01,TC-03` (default: every PASSED case); any non-PASSED case
  in the list refuses the promotion
- `--repo <alias>`: the tests repository when the project has several
- `--dry-run`: write the pack to `<project-home>/exports/<TICKET>/promote/<run-id>/`; push nothing
- `--yes`: push and open the pull request without asking

Exit codes: `0` promoted (or written with `--dry-run`), `2` not confirmed, `3` refused or errors.

## Exploratory testing

### `qajitsu regression`

Runs the regression packs `qj promote` put in the tests repository again (REQ-EXEC-17), without any agent or model.
The packs come from the tests repository (`repos.<alias>.role: tests`) at its `default_ref` or `--ref`, checked out
for this command only, or from a folder (`--from`). Every pack becomes a run of its ticket: the pack's cases are the
approved plan (approved in the name of the pack's original approver), its specs run unchanged with the same sandboxed
runners, and nothing is written, healed, audited or triaged by a model. Before running, every spec is checked against
its SHA-256 in `expectations.yaml` and the expected values against `cases_sha256`; a mismatch makes the case BLOCKED
with the reason. The suite report goes to `exports/regression/<time>/` (`regression.md`, `report.html`,
`junit.xml`) and names as regressions the cases that passed when promoted and fail now; packs that cannot be read are
listed and never count as passed.

- `--env <profile|url>`: environment profile from `.qa/envs` or a URL (default: `environments.default`)
- `--packs <tickets>`: only the packs of these tickets, e.g. `SHOP-482,SHOP-490`
- `--from <dir>`: a folder with packs instead of the tests repository
- `--ref <ref>`: branch, tag or commit of the tests repository (default: its `default_ref`)
- `--publish <ticket>`: after a preview, post the report as a comment on this ticket
- `--yes`: publish without asking

Exit codes: `0` every case passed, `1` at least one regression (FAILED), `2` otherwise (BLOCKED, NOT_RUN, a pack that
could not run, no packs found, or publishing not confirmed), `3` errors.

### `qajitsu release <name>`

Release readiness over every ticket of a fix version or sprint (REQ-PUB-09). The tickets come from the ticket
source: Jira searches `project = <jira.project_key> AND fixVersion = "<name>"` (or `sprint = "<name>"`); a file
source matches the tickets' `fixVersions` and `sprint` fields. For each ticket the latest executed run (not closed by
`qj work reset`) is evaluated by the same code as `publish`. The report shows per ticket the status counts, the open
cases (FAILED, FLAKY, BLOCKED, NEEDS_REVIEW, NOT_RUN), tickets without a run and runs whose publish gates fail
(untrusted). Every number is computed from structured results; a ticket is ready only when its run is trusted and
every case PASSED, and a ticket without a run is never ready. The report is written to
`exports/releases/<name>.md` (`sprint-<name>.md` for a sprint).

- `--sprint`: the name is a sprint, not a fix version
- `--publish <ticket>`: after a preview, post the report as a comment on this ticket (ADF on Cloud, wiki markup on
  Data Center; files with `jira.type: file`); publishing the same release to the same ticket again updates the comment
- `--yes`: publish without asking

Exit codes: `0` every ticket ready, `1` not ready (or no tickets), `2` publishing not confirmed, `3` errors.

### `qajitsu explore <ticket>`

An exploratory session (REQ-EXEC-15): the explorer agent explores the application towards a goal through browser
actions that QAJitsu performs and records (a screenshot after each action, video, trace, network and console, all in
the evidence manifest). It reports observations with steps to reproduce for a person to assess, never statuses, and
writes `explore/<session>/report.html` and `report.md` for review. Needs a fetched run (`qajitsu fetch`). The terminal
shows each action, rejected answer and observation as it happens.

- `--goal <text>`: what to explore (required), e.g. "checkout around the terms change"
- `--run <id>`: run id (default: latest run of the ticket)
- `--env <profile|url>`: environment profile from `.qa/envs` or a URL (default: the environment `qajitsu env up`
  started for this run when it answers, else `environments.default`); an `env up` environment listens on 127.0.0.1 and
  needs no allowlist entry for its random port
- `--time-box <minutes>`: stop after this many minutes (default 10), enforced by code
- `--max-steps <n>`: stop after this many browser actions (default 40), enforced by code
- `--cli <tool>`: explore a command-line tool instead of the application (REQ-EXEC-24, see below)
- `--headed`: show the browser, to watch the agent explore live (needs a display)
- `--slow-mo <ms>`: wait this many milliseconds before every browser action, to follow it
- `--check <item>`: one item of the goal's checklist (repeatable, up to 30); without it the explorer splits the goal
  into its own checklist, which the report marks as written by the explorer

Exit codes: `0` the session ran (whatever it observed), `2` the environment is not healthy, `3` errors.

The explorer's answer is checked by code, not trusted (REQ-EXEC-15/AC8, REQ-EXEC-25). It must act before it answers;
it reports every checklist item, in order, as done with the actions that did it or as not done with the reason;
each finding cites actions; an action id that was not recorded is refused. While the step budget lasts, items left
undone are sent back once to be done. In command-line sessions every flag named in an item, a finding or the comment
must be in the arguments of an action that ran; text the explorer quotes ('…', "…") is a quote of output, not a
claim. Refused answers are journaled (`explore.answer_rejected`). A finding or comment code cannot confirm is sent back
once; if the explorer insists, it is dropped and journaled (`explore.claim_dropped`). An explorer that keeps making
checklist claims code refuses gets its last answer corrected by code instead of losing the session: refused claims
become "not done", items an action ran get that action, each marked "corrected by code" in the report and journaled
(`explore.claim_corrected`). A session
that ends by the time box, the step budget or an error before an accepted answer lists every `--check` item as not
reached. The report shows the checklist, the findings and the explorer's comment last; the terminal says how many
items were done and names those that were not:

```bash
qj explore DEMO-1 --cli qj --goal "doctor and init" \
  --check "qj doctor" --check "qj init without a slug" --check "qj init --qa-dir does-not-exist"
# Session S05 ended: finished; 4 actions, 1 observation(s).
# Checklist: 3 of 3 item(s) done.
```

### `qajitsu explore review <ticket>`

Exploratory sessions can run before the plan. `qajitsu explore review <ticket>` lists every item of the run's sessions,
observations (`O1`), findings (`F1`) and not-done checklist items (`C2`), with their actions and whether a person
accepted, rejected or has not reviewed them yet. In a terminal it asks for each one not reviewed yet; nothing is
accepted by default and an agent cannot accept.

- `--run <id>`: run id (default: latest run of the ticket)
- `--session <id>`: one session (needed with the options below when the run has several sessions)
- `--accept <items>` / `--reject <items>`: decide without prompts, e.g. `--accept O1,C2 --reject F1` (CI, scripts)
- `--note <text>`: why, kept with the decisions
- `--keep <items>`: keep accepted observations or findings in the project's knowledge base (a note per item in the
  project's `explore-notes/`, tagged `exploration`), so planners of later tickets find them like any document

Decisions are kept in `explore/<session>/review.json` with who, when and the SHA-256 of the session file, and
journaled (`explore.reviewed`); if the session file changes, they no longer count. `qajitsu plan` then gives the
planner only the accepted items, as untrusted data. A case may cite one as `{"kind": "explore", "session": "S01",
"item": "O1"}`; code refuses items that do not exist or were not accepted. Exploration says what is worth testing,
never what the result must be: a case citing only exploration becomes an open question, and so does an accepted
not-done item no case covers. The plan output and `plan.vN.md` show the accepted items, the cases from them and what
no case covers.

```bash
qj explore DEMO-1 --goal "cart around the discount change"
qj explore review DEMO-1 --session S01 --accept O1,C2 --reject F1 --keep O1
qj plan DEMO-1     # Exploration: 2 accepted item(s) offered to the planner (S01: O1, C2)
```

Exit codes: `0` listed or recorded, `3` errors (unknown session or item, `--keep` of an item not accepted).

#### Command-line tools (`--cli`, REQ-EXEC-24)

`qajitsu explore <ticket> --cli <tool> --goal "<text>"` explores any command-line tool described under `explore.cli`
in `.qa/qa.project.yaml`, QAJitsu's own `qj` included. Each session runs in a throwaway sandbox: a copy of the tool's
fixture folder with its own HOME and TMPDIR, only PATH, LANG, TERM and the configured variables (secrets by
`secret://`, `{{sandbox}}` and `{{home}}` templates), and an HTTP proxy that lets the tool reach loopback and its
allowlist only. The agent asks for commands (`cli_run` with prompt answers, `cli_start`, `cli_send`, `cli_signal` for
Ctrl+C, `cli_wait`, `cli_read`, `cli_list`, `cli_leftovers`); QAJitsu runs only the configured program, with
argument arrays and never a shell, refuses arguments that name paths outside the sandbox, and records each action's
exit code, changed files and masked output with SHA-256. When the session ends, also after a time-out or an error,
the teardown commands run and every process or container the session left is stopped; the report lists what was left
running, what was stopped and the hosts the proxy refused. A tool that ignores proxy variables is not stopped by the
proxy. The check of arguments that name paths (`/abs`, `~`, `..`, `file:`, `-o/x`, `--out:/x`, `@/x`, links out of
the sandbox) is a guardrail against the agent, not an operating-system boundary: the tool runs with your rights.
`.env`, `.env.*` (except `.env.example`) and `.qa-runs` of the fixture are never copied into the sandbox and cannot be
read. Ctrl+C or SIGTERM stop the session the same way as the time box: what it started is stopped and the sandbox
removed. Output shown live, recorded or put in the report is masked and stripped of terminal escape sequences.

```yaml
explore:
  cli:
    mytool:
      command: [./bin/mytool] # program and fixed arguments; ./ and ../ are from .qa/
      description: Deploys the shop to a test cluster.
      fixture: fixtures/mytool-sandbox # copied into every sandbox
      setup: [[git, init]] # or { command: [...], ok_exit_codes: [0, 2] }
      teardown: [[./bin/mytool, down]]
      env:
        MYTOOL_TOKEN: { secret: secret://env/MYTOOL_TEST_TOKEN }
        DOCKER_CONFIG: { value: "{{home}}/.docker" }
      allowlist: [https://staging.example.com]
      timeout_s: 120
```

**Watching a session live (REQ-EXEC-24/AC9-AC11).** Every session prints one line per action as it ends (command,
exit code or state, duration), each answer of the explorer that code rejected and each observation. `--headed` turns
the terminal of `qj explore` into a live view of the tool: every command as `$ <tool> <args>`, its output as it arrives,
typed answers, Ctrl+C, and the output of background commands prefixed with their id (`[B1]`). `--slow-mo <ms>` waits
before every command, typed line and signal. Everything shown is masked like the evidence. The terminal is always
recorded as `evidence/recordings/terminal.cast` (asciicast v2: `asciinema play evidence/recordings/terminal.cast`) and
`terminal.txt`, both in the manifest with SHA-256, and `report.html` shows the transcript. From a second terminal,
`qj logs <ticket> --follow --stage explore` follows the journal while the session holds the run.

```bash
qj explore DEMO-1 --cli qj --goal "doctor and init" --check "qj doctor" --headed --slow-mo 1000
```

The demo shop configures `qj` itself: `qj explore DEMO-1 --cli qj --goal "qj env up and qj explore on the same run,
with Ctrl+C in the middle"`.

### `qajitsu explore promote <ticket>`

Turns an observation into a draft web case in a new plan version, with the observation as its source and the recorded
actions as steps. It runs only after the plan is approved. For a command-line session it writes a regression test
proposal instead, `explore/<session>/promotions/<observation>.md`: the commands that reproduce it, what happened, what
was expected and the steps as JSON; nothing runs until someone adds it to a test suite.

- `--session <id>`: exploratory session, e.g. `S01` (required)
- `--observation <id>`: observation, e.g. `O1` (required)
- `--run <id>`: run id (default: latest run of the ticket)

Exit codes: `0` plan version written, `3` unknown session or observation, approved plan, or other errors.

## Results and evidence

### `qajitsu evidence <ticket>`

Shows statuses, failed assertions, evidence files and cURL commands; opens the report, videos or a trace.

Screenshots marked by code for failed web and mobile steps (`<step>-annotated.png`, REQ-EVD-08) come first, with
what each numbered red box marks (field, expected, actual); `--failed` also opens them.

The first line names the tool and model versions the run used (REQ-OBS-10).

- `--run <id>`: run id (default: latest run of the ticket)
- `--failed`: only cases that did not pass
- `--case <id>`: only this case
- `--trace <case>`: open the Playwright trace of a case
- `--no-open`: print only, do not open the report, videos or traces
- `--serve`: serve the run's `report/` and `evidence/` on 127.0.0.1 until Ctrl+C (never `env/`, `repos/` or the
  journal; REQ-PRJ-10/AC4)
- `--port <n>`: with `--serve`, the port (default: a free one)

Exit codes: `0` shown, `3` errors.

### `qajitsu watch <ticket>`

Serves a page on 127.0.0.1 with the progress of a run while it runs (REQ-OBS-09): every case of the approved plan,
the step running now with its action, the latest screenshot of web and mobile cases (`<run>/live/`, written by the
trusted runner, not evidence) and the outcome of each finished attempt, marked preliminary. When the run finished the
page shows the statuses computed by QAJitsu; a run that is neither running nor finished is shown as stopped with
its last event. Only the page, `progress.json` and the live screenshots are served. Runs until Ctrl+C.

- `--run <id>`: run id (default: latest run of the ticket)
- `--port <n>`: port (default: a free one)

Exit codes: `0` stopped with Ctrl+C, `3` errors.

### `qajitsu logs <ticket>`

Shows the structured event log of a run.

- `--run <id>`: run id (default: latest run of the ticket)
- `--follow`: keep printing new events while the run is running, or while another `qj` process holds it (an
  exploratory session, `env up`); stops when it ends
- `--stage <stage>`: only this stage, e.g. `run` or `plan`
- `--agent <role>`: only this agent, e.g. `planner`
- `--case <id>`: only events of this case

Exit codes: `0` shown, `3` errors.

### `qajitsu pull <ticket>`

Downloads the evidence zip of a run (e.g. from CI) from the ticket and verifies it.

- `--run <id>`: run id (required)

Exit codes: `0` pulled and verified, `2` pulled but the hashes differ, `3` errors.

### `qajitsu export <ticket>`

Writes pipeline artifacts of a run: `report.html`, `junit.xml`, the matrix and the evidence zip. It ends with the
statuses, what the exit code means, and the GO / NO-GO decision (REQ-PUB-10; also a `qajitsu.decision` property in
`junit.xml`).

- `--run <id>`: run id (default: latest run of the ticket)
- `--out <dir>`: output folder, e.g. `qa-artifacts` (default: `<project-home>/exports/<TICKET>/<RUN>/`)

Exit codes: the run's code (`0`, `1`, `2`) so a pipeline step can fail on it, `3` errors.

### `qajitsu map`

Application map over every run: tested and never-tested screens and endpoints (`map.json`, `map.html`).

- `--out <dir>`: output folder (default: `<project-home>/exports/qa-map`)
- `--openapi <file>`: OpenAPI document of the known endpoints (default: from the newest worktree)

Exit codes: `0` written, `3` errors.

## Knowledge base

Documents a project adds on demand, searched by the analyst and planner with cited sources (REQ-KNOW, ADR-0007). One
knowledge base per project in `<project-home>/knowledge/`: a LanceDB store, `sources.yaml` and `index.json`.
Documentation that fits `knowledge.full_context_tokens` is used without embeddings; above it retrieval is hybrid
(vectors from `knowledge.embedding` plus keywords). Content is masked before it is stored; `.env` files, keys and
certificates are never indexed.

### `qajitsu knowledge add [paths...]`

Registers files and folders (recursive) as sources and indexes them: Markdown, text, HTML, DOCX, PDF (with a text layer) and OpenAPI (one chunk
group per operation); other files are skipped and listed. Adding a registered path again only processes new or
changed files and prints counts of added, updated, unchanged, skipped and removed files (REQ-KNOW-02).

- `--include <glob>`: only files matching this glob (repeatable)
- `--exclude <glob>`: skip files matching this glob (repeatable)
- `--tag <tag>`: tag the documents of this source (repeatable)
- `--qa-knowledge`: add the project's `.qa/knowledge/` folder (REQ-KNOW-01/AC2)
- `--yes`: confirm sending document text to a cloud embedding model (REQ-KNOW-09/AC2)

Exit codes: `0` indexed, `3` errors or no confirmation for a cloud model.

Online sources (REQ-KNOW-12) instead of paths: `confluence:<SPACE>` (a whole space) or `confluence:<SPACE>/<page id>`
(a page and its descendants), from `knowledge.confluence` (on Jira Cloud by default `<jira.base_url>/wiki` with the
Jira credentials); `jira:bugs` or `jira:bugs/<component>` (resolved bugs of the project, tagged
`component-<name>`). They sync by page version or issue update time: only changed documents are downloaded.

### `qajitsu knowledge sync`

Re-processes changed files (by content hash), removes chunks of deleted files and adds new files of every registered
source (REQ-KNOW-04).

- `--dry-run`: only show what would change
- `--yes`: confirm sending document text to a cloud embedding model

Exit codes: `0` synced, `3` errors.

### `qajitsu knowledge remove <source-or-file>`

Removes a source and all its chunks, or one file, which is then excluded from its source so `sync` does not bring it
back (REQ-KNOW-03/AC1).

Exit codes: `0` removed, `3` unknown source or file.

### `qajitsu knowledge reset`

Empties the knowledge base after confirmation (REQ-KNOW-03/AC2).

- `--keep-sources`: keep the registered sources for a later `sync`
- `--yes`: do not ask for confirmation

Exit codes: `0` emptied, `3` not confirmed or errors.

### `qajitsu knowledge reindex`

Stores every chunk again with the configured embedding model and retrieval mode; needed after changing
`knowledge.embedding` (REQ-KNOW-08/AC2).

- `--yes`: confirm sending document text to a cloud embedding model

Exit codes: `0` rebuilt, `3` errors.

### `qajitsu knowledge list`

Sources with file and chunk counts, tags and last sync, plus the embedding model, retrieval mode, store and size on
disk (REQ-KNOW-05/AC1, REQ-KNOW-07/AC3).

Exit codes: `0` listed, `3` errors.

### `qajitsu knowledge search <query>`

Prints the ranked chunks agents would get, with source path, section, date and chunk id, to check retrieval quality
(REQ-KNOW-05/AC2).

- `--tag <tag>`: only documents with this tag (repeatable)
- `--limit <n>`: number of results (default 5)

Exit codes: `0` searched, `3` errors.

## Environment

### `qajitsu env check`

Lists every missing or invalid variable of the environment profile and the `--build` configuration (every account of
a pool included); starts nothing. Warns (`! accounts:`) when an account pool is smaller than the number of cases that
can need it at once (REQ-ENV-09/AC5); those cases wait for a free account, which is not an error.

- `--env <profile>`: environment profile (default: `build.profile` or `environments.default`)

Exit codes: `0` complete, `3` something is missing or invalid.

### `qajitsu env up <ticket>`

Starts the application from a fetched run's worktree exactly as `run --build` would, without agents or tests, and
prints the service URLs. Ctrl+C stops it; the worktree stays for a later `run`.

- `--run <id>`: run id (default: latest run of the ticket)
- `--set <service.VAR=value>`: override an overridable service variable (repeatable)
- `--detach`: leave the containers running (containers only); remove them with `qajitsu clean`

Exit codes: `0` started and stopped (or detached), `2` the environment did not start (the service logs are named),
`3` configuration errors.

### `qajitsu env render <ticket>`

Recreates the per-service `.env` files of a run (0600; they contain secrets and are removed by `clean`).

- `--run <id>`: run id (default: latest run of the ticket)

Exit codes: `0` written, `3` errors.

## Runs

### `qajitsu runs <ticket>`

Lists the runs of a ticket with stage, status, results and retention.

Below the table, the tool and model versions each run recorded (REQ-OBS-10).

- `--keep <id>`: mark a run keep: `gc`, `clean --project` and `work reset --delete` never remove it or its evidence
  (REQ-PRJ-10/AC6)
- `--unkeep <id>`: let a run follow the retention policy again

Exit codes: `0` listed (also when there are none), `3` errors or an unknown run.

### `qajitsu status`

The active project at a glance (REQ-PRJ-05): configuration readiness, default environment, knowledge base, and every
ticket with unfinished work, its state ("plan v2 waiting for approval", "results not published", "interrupted during
run") and the command that continues it, with the ticket's latest notes, then the environments still running for its
runs (`run --build`, `env up --detach`) with their URLs and `qajitsu clean` to stop them. Computed from the run
folders; `context.json` in the project home is only an index of it.

- `--all`: every project
- `--rebuild`: rebuild `context.json` from the run folders

Exit codes: `0` shown, `3` errors.

### `qajitsu note <ticket> <text>`

Attaches a note to a ticket; `status` shows it next to the ticket's work. Known secrets in the text are masked.

Exit codes: `0` stored, `3` empty note or errors.

### `qajitsu resume [ticket]`

Continues a run from its last checkpoint; stops at plan approval and publishing. Without a ticket it lists the
resumable work of the project with the command for each. When the environment or a secret changed after the plan was
approved, the run does not continue silently: interactively it asks for confirmation, otherwise it stops with
`RUN_CONTEXT_CHANGED` (REQ-PRJ-06/AC3).

- `--run <id>`: run id (default: latest run of the ticket)
- `--env <profile|url>`: environment for the run stage
- `--build`: build the environment for the run stage

Exit codes: the code of the stage it continued (`plan` or `run`); `0` when the run is complete, `2` when it waits for
a person (approval or publish), `3` errors.

### `qajitsu clean [ticket]`

Removes containers, volumes, networks, worktrees and `.env` files of a run; results, evidence and reports stay.
With `--project` it applies retention (`cleanup.keep_last`, `cleanup.max_age_days`) to every run of the project and
removes git mirrors not fetched within `max_age_days` (REQ-PRJ-07/AC2).

- `--run <id>`: run id (default: latest run of the ticket)
- `--all`: every run of the ticket
- `--project`: every run and git mirror of the project instead of one ticket
- `--dry-run`: with `--project`, only list what would be removed

Exit codes: `0` cleaned (runs in use by another process are skipped and listed), `3` errors.

### `qajitsu work reset <ticket>`

Closes the open work of a ticket (REQ-PRJ-07/AC1): `status` and `resume` stop offering it, commands without `--run`
refuse the closed run with `RUN_CLOSED`, and the next `fetch` starts a new run. Old runs stay and can still be named
with `--run`.

- `--delete`: also remove the ticket's runs (except runs marked keep); journals are archived first

Exit codes: `0` closed, `3` errors.

### `qajitsu gc`

Applies retention (`cleanup.keep_last`, `cleanup.max_age_days`) to every ticket; journals are archived first.

- `--dry-run`: only list the runs that would be removed

Exit codes: `0` done, `3` errors.

## Models and integrity

### `qajitsu bench`

Benchmarks a model on the seeded-bug cases: detection, false FAILED, BLOCKED, plan acceptance, time and cost.
Makes real model calls; never in PR CI.

- `--model <ref>`: the model to measure, e.g. `ollama/qwen2.5-coder:32b` (required)
- `--role <role>`: only this role uses the model (default: every role)
- `--cases <file>`: benchmark cases (default: `.qa/bench.yaml`)
- `--out <dir>`: where the JSON report goes (default: `<project-home>/exports/bench-results`)
- `--knowledge <mode>`: `on` (default; the knowledge base when the project has one), `off`, or `compare`: every case
  runs without and then with the knowledge base, and the report shows the difference in detection, false FAILED,
  BLOCKED and plans accepted without edits (REQ-KNOW-11)

Exit codes: `0` the benchmark completed (whatever the scores), `3` configuration errors.

### `qajitsu audit verify [ticket]`

Checks the hash chain of run journals, also archived ones.

- `--run <id>`: run id (default: latest run of the ticket)
- `--all`: every run of the ticket
- `--file <journal>`: verify this journal file instead

Exit codes: `0` every journal intact, `1` a chain is broken, `3` errors.

### `qajitsu audit trail <ticket>`

Lists everything that influenced the verdict of a run, with the SHA-256 of every file (REQ-VER-16): the ticket
snapshot, commit and diff, every plan version and its approval, the generated tests, tool versions, container image
digests, the tested environment, raw runner output, evidence, checks, reports, the event journal and the agent
transcript (`journal/agents.jsonl`: every prompt, answer and tool call, masked). Writes `audit/trail.json` and lists
the gaps: a missing file, a hash that does not match, a model call without its stored prompt and answer. The trail is
always recomputed from the files; an edited `trail.json` changes nothing.

- `--run <id>`: run id (default: latest run of the ticket)

Exit codes: `0` the trail is complete, `1` it has gaps, `3` errors.

### `qajitsu audit export <ticket>`

The audit trail of a run as one zip for an external auditor, readable without QAJitsu: the files, `audit/trail.json`,
`SHA256SUMS` (check with `sha256sum -c SHA256SUMS`) and a `README.txt`. Every file is secret-scanned first; a secret
value stops the export. `env/` is never included; Playwright traces stay with the run and are named in the README.

- `--run <id>`: run id (default: latest run of the ticket)
- `--out <file>`: zip to write (default: the project's exports folder)

Exit codes: `0` written from a complete trail, `1` written but the trail has gaps, `3` errors.

## Observability

### `qajitsu telemetry export <ticket>`

Sends journal events not exported yet as OTLP traces, logs and metrics.

- `--run <id>`: run id (default: latest run of the ticket)

Exit codes: `0` exported, `3` telemetry not configured or the export failed.

### `qajitsu metrics`

Metrics over every run, as Prometheus text or JSON, for dashboards and alerts.

- `--format <format>`: `prometheus` (default) or `json`
- `--out <file>`: write to a file atomically, e.g. for the node_exporter textfile collector

Exit codes: `0` written, `3` errors.

## CI

### `qajitsu ci detect`

Works out the trigger: a labelled PR/MR, a `/qa` comment, a manual run or a Jira dispatch; writes `$GITHUB_OUTPUT`.

- `--label <name>`: PR/MR label that starts QAJitsu (default: `qa-agent`)
- `--paths <glob...>`: only when a changed file matches one of these globs
- `--format <format>`: `json` (default) or `env` (shell-safe export lines)

Exit codes: `0` detected (also "nothing to do"; read the output), `3` errors.

### `qajitsu ci comment <ticket>`

Posts the plan or the results to the PR/MR as one updatable comment and sets the status check.

- `--change <url>`: the PR/MR (required)
- `--run <id>`: run id (default: latest run of the ticket)

Exit codes: `0` posted, `3` errors.

### `qajitsu ci publish-plan <ticket>`

Posts the latest plan version to the Jira ticket as one updatable comment.

- `--run <id>`: run id (default: latest run of the ticket)

Exit codes: `0` posted, `3` errors.
