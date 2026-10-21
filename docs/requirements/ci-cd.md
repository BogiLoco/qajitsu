# CI/CD integration (CI)

The same CLI runs inside pipelines; humans still approve plans.

### REQ-CI-01 · Ready-made integrations

- Status: implemented
- Priority: must
- Stage: 10
- Related: REQ-GEN-05

**Acceptance criteria**

- [x] AC1: GitHub Action `qajitsu-action` with commands `plan` and `run`.
- [x] AC2: GitLab CI template with `.qa-plan` and `.qa-run` jobs.
- [x] AC3: Docker image with Node.js, Playwright browsers and git for other CI systems (e.g. Jenkins).

### REQ-CI-02 · Triggers

- Status: implemented
- Priority: should
- Stage: 10
- Related: REQ-CTX-03

**Acceptance criteria**

- [x] AC1: PR/MR with a configurable label (default `qa-agent`); ticket key from branch or title.
- [x] AC2: Jira status change (e.g. "Ready for QA") via webhook or Jira automation.
- [x] AC3: Manual trigger with ticket, environment and mode parameters.

### REQ-CI-03 · Plan approval inside the pipeline

- Status: implemented
- Priority: must
- Stage: 10
- Related: REQ-PLAN-07

**Acceptance criteria**

- [x] AC1: `plan` job publishes the plan to the PR/MR, Jira and pipeline artifacts.
- [x] AC2: `/qa revise <text>` comment re-runs planning with a new version.
- [x] AC3: Approval starts the `run` job: GitHub protected environment with reviewers, GitLab manual job, or `/qa approve`.
- [x] AC4: Re-runs after new commits reuse the approved plan if the ticket did not change; new plans are never auto-approved.

### REQ-CI-04 · Outputs for pipelines

- Status: implemented
- Priority: must
- Stage: 10
- Related: REQ-VER-01

**Acceptance criteria**

- [x] AC1: Exit codes: 0 all passed, 1 any failed, 2 blocked/flaky/not run/needs review without failures, 3 framework or configuration error.
- [x] AC2: JUnit XML report.
- [x] AC3: Evidence zip and `report.html` as pipeline artifacts.
- [x] AC4: Status check and comment on the PR/MR.

### REQ-CI-05 · Gradual rollout and cost control

- Status: implemented
- Priority: should
- Stage: 10
- Related: REQ-LLM-07

**Acceptance criteria**

- [x] AC1: Documentation describes starting in informational mode and making the check required once false FAILED is low.
- [x] AC2: Runs limited by label or changed paths; per-run timeout and token budget; caches for git mirrors and browsers.
- [x] AC3: Secrets from CI stores or OIDC to cloud secret managers; mobile requires KVM (Android) or macOS runners/device farms (iOS).

### REQ-CI-06 · Toolchain in pipelines

- Status: in-progress
- Priority: could
- Stage: later
- Related: REQ-GEN-06, REQ-CI-04

**Acceptance criteria**

- [x] AC1: The GitHub Action and the GitLab template cache `~/.qajitsu/toolchain/` keyed by the toolchain manifest and `.qa/toolchain.yaml`, so a pipeline installs a tool once and later jobs reuse it.
- [ ] AC2: A Docker image with Java, the Android SDK, emulator, system image and Appium installed by `qj setup` runs Android tests on a host with KVM; the documentation names the hosts where it cannot (no nested virtualisation).

### REQ-CI-07 · Thin CI client

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-CI-01, REQ-CI-04, REQ-SCALE-01, REQ-SCALE-03, REQ-VER-15, REQ-CFG-03, INV-1

A pipeline step that does not run QAJitsu itself: it starts a run in the QAJitsu cloud or in the customer's own
QAJitsu installation, follows it and reports back, so the CI runner needs no browsers, devices or models.

**Acceptance criteria**

- [ ] AC1: A CI step starts a run in the QAJitsu cloud or in a QAJitsu installation of the customer and shows its progress in the CI log (stages, cases, statuses) until it ends.
- [ ] AC2: A time-out ends the step with the exit code of BLOCKED, never with success; a lost connection or a run that cannot be followed ends the same way, with the reason.
- [ ] AC3: The step authenticates with short-lived tokens or OIDC (for example the CI provider's identity token exchanged for a run-scoped token); no long-lived key is stored in the repository or the pipeline configuration.
- [ ] AC4: The link to the report and the certificate id (REQ-VER-15) are posted to the pull or merge request.
- [ ] AC5: The step's exit code follows the run's computed statuses (REQ-CI-04), never a status reported by the client itself.
