# Requirements catalogue

This folder is the **source of truth for what QAJitsu must do**. Every feature, test, commit and PR traces back to a requirement id here.
The original planning document (`docs/plan.md`, Polish) explains the rationale; when the two disagree, this catalogue wins.

## Areas

| Prefix | File                                   | Scope                                                                |
| ------ | -------------------------------------- | -------------------------------------------------------------------- |
| CTX    | [context.md](context.md)               | Jira ticket, linked changes, GitHub/GitLab repositories, code access |
| PLAN   | [plan.md](plan.md)                     | Analysis, test plan, approval and revisions                          |
| ENV    | [environment.md](environment.md)       | Existing environments, local builds, health checks, allowlists       |
| CFG    | [config-secrets.md](config-secrets.md) | Project config, variables, secrets, test accounts                    |
| WS     | [workspace.md](workspace.md)           | Run folders, unique ids, retention and cleanup                       |
| EXEC   | [execution.md](execution.md)           | Test authoring, runners (API, web, mobile), healing, retries         |
| VER    | [verification.md](verification.md)     | Anti-hallucination layer: statuses, guard, gates, auditor            |
| EVD    | [evidence.md](evidence.md)             | Screenshots, videos, request/response, manifest, matrix              |
| PUB    | [publishing.md](publishing.md)         | Jira comment, attachments, local report and video sharing            |
| LLM    | [models.md](models.md)                 | Providers (cloud, LiteLLM, Ollama), roles, capabilities, costs       |
| OBS    | [observability.md](observability.md)   | Event log, log viewer, OpenTelemetry, transition graph               |
| CI     | [ci-cd.md](ci-cd.md)                   | GitHub Actions, GitLab CI, approvals inside pipelines                |
| GEN    | [generic.md](generic.md)               | Plugging into any project, adapters, CLI                             |
| NFR    | [non-functional.md](non-functional.md) | Code standards, tests, docs, security, open source                   |
| PRJ    | [projects.md](projects.md)             | Projects on one machine: homes, switching, status, isolation         |
| KNOW   | [knowledge.md](knowledge.md)           | Knowledge base per project: add, sync, search, agent access          |

Related documents: [roadmap](../roadmap.md) (stages), [architecture overview](../architecture/overview.md),
[invariants](../../.claude/rules/architecture-invariants.md) (`INV-1`..`INV-12`), [ADRs](../adr/) (`ADR-nnnn`), [glossary](../glossary.md).

## Format

Each requirement is an H3 heading followed by a metadata list, an optional description and acceptance criteria:

```markdown
### REQ-PLAN-04 · Human approval before execution

- Status: implemented
- Priority: must
- Stage: 2
- Related: INV-3, REQ-PLAN-05

Optional description: why it exists, context, non-goals.

**Acceptance criteria**

- [x] AC1: Observable, testable statement.
- [x] AC2: Ticked when implemented and covered by a test.
```

Copy [`_template.md`](_template.md) when adding one.

| Field    | Values                         | Meaning                                                                           |
| -------- | ------------------------------ | --------------------------------------------------------------------------------- |
| Id       | `REQ-<AREA>-NN`                | Area prefix from the file's H1, two-digit number. **Never renumbered or reused.** |
| Status   | `proposed`                     | Idea under discussion; not planned yet                                            |
|          | `accepted`                     | Agreed, planned for its stage                                                     |
|          | `in-progress`                  | Being implemented                                                                 |
|          | `implemented`                  | All acceptance criteria ticked and tested                                         |
|          | `deferred`                     | Accepted but moved out of the current plan                                        |
|          | `deprecated`                   | No longer wanted; kept for history (say why and what replaces it)                 |
| Priority | `must`, `should`, `could`      | MoSCoW; `must` blocks the stage it belongs to                                     |
| Stage    | `1`..`10`, `later`             | Roadmap stage, see [roadmap](../roadmap.md)                                       |
| Related  | `REQ-...`, `INV-n`, `ADR-nnnn` | Comma-separated; every reference must exist                                       |

Acceptance criteria are numbered `AC1`, `AC2`, ... within the requirement and referenced as `REQ-VER-03/AC2`.

## Working with requirements

**Add.** Pick the area file, take the next free number, copy the template, start with `Status: proposed`
(or `accepted` if agreed). Run `pnpm req:index` and `pnpm req:check`. Claude Code: `/requirement add ...`.

**Change.** Edit in place. Changing meaning of an `implemented` requirement means: set it back to `in-progress`,
untick affected criteria, and add the tests. Large changes to scope get a new requirement and the old one becomes `deprecated`.

**Remove.** Never delete. Set `Status: deprecated` and add a line `Replaced by REQ-...` or the reason.

**Implement.** Reference the id everywhere:

- test titles: `it("REQ-VER-03/AC1: denies agent writes to results/", ...)`
- commits: footer `Refs: REQ-VER-03`
- PRs: "Requirements" section in the PR template
- code: only when a non-obvious line exists because of a requirement, e.g. `// REQ-WS-02: ids must be filesystem-safe`

Tick a criterion (`[x]`) only when it is implemented **and** covered by a test. When all are ticked, set `implemented`.

**Check.** `pnpm req:check` (part of `pnpm verify` and CI) validates: unique ids, prefix matches the file, valid status,
priority and stage, every `Related` reference exists, at least one criterion, `implemented` has all criteria ticked,
and the index below is up to date. `pnpm req:index` regenerates the index.

## Index

Generated by `pnpm req:index`. Do not edit by hand.

<!-- prettier-ignore-start -->
<!-- req-index:start -->
136 requirements (1 proposed, 3 accepted, 128 implemented, 4 deferred); 423/442 acceptance criteria done.

| Id | Title | Status | Priority | Stage | AC done |
| --- | --- | --- | --- | --- | --- |
| [REQ-CTX-01](context.md#req-ctx-01--jira-ticket-as-the-input) | Jira ticket as the input | implemented | must | 1 | 5/5 |
| [REQ-CTX-02](context.md#req-ctx-02--github-and-gitlab-support) | GitHub and GitLab support | implemented | must | 1 | 4/4 |
| [REQ-CTX-03](context.md#req-ctx-03--change-discovery-for-a-ticket) | Change discovery for a ticket | implemented | must | 1 | 5/5 |
| [REQ-CTX-04](context.md#req-ctx-04--repositories-always-fetched-at-the-changes-version) | Repositories always fetched at the change's version | implemented | must | 1 | 4/4 |
| [REQ-CTX-05](context.md#req-ctx-05--code-analysis-context-for-agents) | Code analysis context for agents | implemented | must | 2 | 6/6 |
| [REQ-CTX-06](context.md#req-ctx-06--test-repository-awareness) | Test repository awareness | implemented | should | 3 | 4/4 |
| [REQ-CTX-07](context.md#req-ctx-07--project-knowledge-for-agents) | Project knowledge for agents | implemented | should | 2 | 2/2 |
| [REQ-CTX-08](context.md#req-ctx-08--import-existing-manual-test-cases) | Import existing manual test cases | implemented | could | later | 4/4 |
| [REQ-PLAN-01](plan.md#req-plan-01--change-analysis-and-classification) | Change analysis and classification | implemented | must | 2 | 3/3 |
| [REQ-PLAN-02](plan.md#req-plan-02--structured-test-plan) | Structured test plan | implemented | must | 2 | 4/4 |
| [REQ-PLAN-03](plan.md#req-plan-03--grounded-sources) | Grounded sources | implemented | must | 2 | 2/2 |
| [REQ-PLAN-04](plan.md#req-plan-04--human-review-loop) | Human review loop | implemented | must | 2 | 3/3 |
| [REQ-PLAN-05](plan.md#req-plan-05--open-questions-instead-of-guessing) | Open questions instead of guessing | implemented | must | 2 | 2/2 |
| [REQ-PLAN-06](plan.md#req-plan-06--plan-freeze) | Plan freeze | implemented | must | 2 | 4/4 |
| [REQ-PLAN-07](plan.md#req-plan-07--approval-channels) | Approval channels | deferred | should | 10 | 3/4 |
| [REQ-PLAN-08](plan.md#req-plan-08--test-depth-and-budget) | Test depth and budget | implemented | should | later | 3/3 |
| [REQ-ENV-01](environment.md#req-env-01--provided-environment) | Provided environment | implemented | must | 3 | 3/3 |
| [REQ-ENV-02](environment.md#req-env-02--deployed-version-check) | Deployed version check | implemented | should | 3 | 3/3 |
| [REQ-ENV-03](environment.md#req-env-03--build-the-environment-from-repositories) | Build the environment from repositories | implemented | must | 6 | 3/3 |
| [REQ-ENV-04](environment.md#req-env-04--readiness-seeding-and-start-failures) | Readiness, seeding and start failures | implemented | must | 6 | 3/3 |
| [REQ-ENV-05](environment.md#req-env-05--stubs-for-external-dependencies) | Stubs for external dependencies | implemented | should | 6 | 2/2 |
| [REQ-ENV-06](environment.md#req-env-06--mobile-apps-and-devices) | Mobile apps and devices | implemented | must | 8 | 3/3 |
| [REQ-ENV-07](environment.md#req-env-07--default-environment-selection) | Default environment selection | implemented | should | 3 | 2/2 |
| [REQ-ENV-08](environment.md#req-env-08--message-capture-email-sms-and-webhooks) | Message capture: email, SMS and webhooks | implemented | should | later | 5/5 |
| [REQ-CFG-01](config-secrets.md#req-cfg-01--layered-configuration) | Layered configuration | implemented | must | 6 | 2/2 |
| [REQ-CFG-02](config-secrets.md#req-cfg-02--service-variable-schema-and-templates) | Service variable schema and templates | implemented | must | 6 | 3/3 |
| [REQ-CFG-03](config-secrets.md#req-cfg-03--secret-providers) | Secret providers | implemented | must | 1 | 3/3 |
| [REQ-CFG-04](config-secrets.md#req-cfg-04--validate-configuration-before-start) | Validate configuration before start | implemented | must | 6 | 2/2 |
| [REQ-CFG-05](config-secrets.md#req-cfg-05--generated-env-files) | Generated .env files | implemented | must | 6 | 3/3 |
| [REQ-CFG-06](config-secrets.md#req-cfg-06--masking) | Masking | implemented | must | 3 | 3/3 |
| [REQ-CFG-07](config-secrets.md#req-cfg-07--test-accounts-as-aliases) | Test accounts as aliases | implemented | must | 3 | 2/2 |
| [REQ-WS-01](workspace.md#req-ws-01--folder-per-ticket-and-run-id) | Folder per ticket and run id | implemented | must | 1 | 4/4 |
| [REQ-WS-02](workspace.md#req-ws-02--labels-and-names-for-runtime-resources) | Labels and names for runtime resources | implemented | must | 6 | 2/2 |
| [REQ-WS-03](workspace.md#req-ws-03--cleanup-policy-and-retention) | Cleanup policy and retention | implemented | must | 6 | 4/4 |
| [REQ-WS-04](workspace.md#req-ws-04--run-management-commands) | Run management commands | implemented | should | 6 | 3/3 |
| [REQ-EXEC-01](execution.md#req-exec-01--executable-specs-from-the-approved-plan) | Executable specs from the approved plan | implemented | must | 3 | 3/3 |
| [REQ-EXEC-02](execution.md#req-exec-02--steps-library-step-and-verify) | Steps library: `step()` and `verify()` | implemented | must | 3 | 4/4 |
| [REQ-EXEC-03](execution.md#req-exec-03--static-checks-before-execution) | Static checks before execution | implemented | must | 3 | 4/4 |
| [REQ-EXEC-04](execution.md#req-exec-04--api-testing) | API testing | implemented | must | 3 | 3/3 |
| [REQ-EXEC-05](execution.md#req-exec-05--web-ui-testing) | Web UI testing | implemented | must | 5 | 3/3 |
| [REQ-EXEC-06](execution.md#req-exec-06--mobile-testing-android-and-ios) | Mobile testing (Android and iOS) | implemented | must | 8 | 3/3 |
| [REQ-EXEC-07](execution.md#req-exec-07--mixed-cases) | Mixed cases | implemented | should | 5 | 1/1 |
| [REQ-EXEC-08](execution.md#req-exec-08--retries-and-flaky) | Retries and FLAKY | implemented | must | 3 | 3/3 |
| [REQ-EXEC-09](execution.md#req-exec-09--healer-limited-to-selectors-and-waits) | Healer limited to selectors and waits | implemented | must | 5 | 3/3 |
| [REQ-EXEC-10](execution.md#req-exec-10--parallelism) | Parallelism | implemented | should | 5 | 2/2 |
| [REQ-EXEC-11](execution.md#req-exec-11--human-in-the-loop-steps) | Human-in-the-loop steps | implemented | should | later | 7/7 |
| [REQ-EXEC-12](execution.md#req-exec-12--visual-regression) | Visual regression | implemented | could | later | 4/4 |
| [REQ-EXEC-13](execution.md#req-exec-13--browser-and-viewport-matrix) | Browser and viewport matrix | implemented | could | later | 3/3 |
| [REQ-EXEC-14](execution.md#req-exec-14--locale-testing) | Locale testing | implemented | could | later | 3/3 |
| [REQ-EXEC-15](execution.md#req-exec-15--exploratory-sessions) | Exploratory sessions | implemented | could | later | 6/6 |
| [REQ-EXEC-16](execution.md#req-exec-16--run-one-case-with-a-live-view) | Run one case with a live view | accepted | should | later | 0/4 |
| [REQ-EXEC-17](execution.md#req-exec-17--regression-runs-of-promoted-packs) | Regression runs of promoted packs | proposed | should | later | 0/4 |
| [REQ-VER-01](verification.md#req-ver-01--status-model) | Status model | implemented | must | 1 | 3/3 |
| [REQ-VER-02](verification.md#req-ver-02--verdict-from-runner-output-only) | Verdict from runner output only | implemented | must | 3 | 3/3 |
| [REQ-VER-03](verification.md#req-ver-03--write-bans-for-agents) | Write bans for agents | implemented | must | 1 | 3/3 |
| [REQ-VER-04](verification.md#req-ver-04--tool-call-journal) | Tool-call journal | implemented | must | 1 | 2/2 |
| [REQ-VER-05](verification.md#req-ver-05--evidence-manifest-with-hashes) | Evidence manifest with hashes | implemented | must | 3 | 3/3 |
| [REQ-VER-06](verification.md#req-ver-06--independent-auditor) | Independent auditor | implemented | must | 7 | 3/3 |
| [REQ-VER-07](verification.md#req-ver-07--publish-gates) | Publish gates | implemented | must | 3 | 7/7 |
| [REQ-VER-08](verification.md#req-ver-08--computed-numbers-and-validated-summary) | Computed numbers and validated summary | implemented | must | 3 | 2/2 |
| [REQ-VER-09](verification.md#req-ver-09--canary-check) | Canary check | implemented | could | 7 | 2/2 |
| [REQ-VER-10](verification.md#req-ver-10--human-preview-before-publishing) | Human preview before publishing | implemented | must | 4 | 2/2 |
| [REQ-VER-11](verification.md#req-ver-11--bug-fix-verification-fails-before-passes-after) | Bug fix verification: fails before, passes after | implemented | should | later | 4/4 |
| [REQ-VER-12](verification.md#req-ver-12--failure-triage-hints) | Failure triage hints | implemented | should | later | 4/4 |
| [REQ-EVD-01](evidence.md#req-evd-01--api-evidence) | API evidence | implemented | must | 3 | 3/3 |
| [REQ-EVD-02](evidence.md#req-evd-02--web-evidence) | Web evidence | implemented | must | 5 | 3/3 |
| [REQ-EVD-03](evidence.md#req-evd-03--mobile-evidence) | Mobile evidence | implemented | must | 8 | 3/3 |
| [REQ-EVD-04](evidence.md#req-evd-04--test-matrix) | Test matrix | implemented | must | 3 | 3/3 |
| [REQ-EVD-05](evidence.md#req-evd-05--report-formats) | Report formats | implemented | must | 3 | 3/3 |
| [REQ-EVD-06](evidence.md#req-evd-06--media-policy) | Media policy | implemented | should | 5 | 2/2 |
| [REQ-EVD-07](evidence.md#req-evd-07--passive-observations-during-tests) | Passive observations during tests | implemented | should | later | 5/5 |
| [REQ-PUB-01](publishing.md#req-pub-01--jira-comment) | Jira comment | implemented | must | 4 | 4/4 |
| [REQ-PUB-02](publishing.md#req-pub-02--attachments) | Attachments | deferred | must | 4 | 2/3 |
| [REQ-PUB-03](publishing.md#req-pub-03--jira-cloud-and-data-center) | Jira Cloud and Data Center | implemented | should | 4 | 2/2 |
| [REQ-PUB-04](publishing.md#req-pub-04--idempotent-publishing) | Idempotent publishing | implemented | must | 4 | 2/2 |
| [REQ-PUB-05](publishing.md#req-pub-05--optional-integrations) | Optional integrations | deferred | could | later | 1/4 |
| [REQ-PUB-06](publishing.md#req-pub-06--failure-videos-and-evidence-for-the-user) | Failure videos and evidence for the user | implemented | must | 5 | 3/3 |
| [REQ-PUB-07](publishing.md#req-pub-07--bug-reports-from-failed-cases) | Bug reports from failed cases | implemented | should | later | 5/5 |
| [REQ-PUB-08](publishing.md#req-pub-08--promote-ticket-cases-to-the-regression-suite) | Promote ticket cases to the regression suite | implemented | should | later | 4/4 |
| [REQ-PUB-09](publishing.md#req-pub-09--release-readiness-report) | Release readiness report | implemented | could | later | 4/4 |
| [REQ-LLM-01](models.md#req-llm-01--multiple-providers) | Multiple providers | deferred | must | 2 | 4/5 |
| [REQ-LLM-02](models.md#req-llm-02--model-per-role) | Model per role | implemented | must | 2 | 2/2 |
| [REQ-LLM-03](models.md#req-llm-03--capability-profiles) | Capability profiles | implemented | must | 2 | 3/3 |
| [REQ-LLM-04](models.md#req-llm-04--structured-output-with-repair) | Structured output with repair | implemented | must | 2 | 3/3 |
| [REQ-LLM-05](models.md#req-llm-05--local-models-used-honestly) | Local models used honestly | implemented | should | 7 | 2/2 |
| [REQ-LLM-06](models.md#req-llm-06--model-benchmark) | Model benchmark | implemented | should | 7 | 3/3 |
| [REQ-LLM-07](models.md#req-llm-07--cost-and-token-tracking) | Cost and token tracking | implemented | should | 2 | 2/2 |
| [REQ-OBS-01](observability.md#req-obs-01--structured-event-log-per-run) | Structured event log per run | implemented | must | 1 | 2/2 |
| [REQ-OBS-02](observability.md#req-obs-02--viewing-logs) | Viewing logs | implemented | must | 5 | 2/2 |
| [REQ-OBS-03](observability.md#req-obs-03--opentelemetry-export) | OpenTelemetry export | implemented | should | 9 | 2/2 |
| [REQ-OBS-04](observability.md#req-obs-04--metrics-dashboards-and-alerts) | Metrics, dashboards and alerts | implemented | could | 9 | 3/3 |
| [REQ-OBS-05](observability.md#req-obs-05--tamper-evident-audit-log) | Tamper-evident audit log | implemented | should | 9 | 2/2 |
| [REQ-OBS-06](observability.md#req-obs-06--transition-graph-per-run) | Transition graph per run | implemented | should | 5 | 3/3 |
| [REQ-OBS-07](observability.md#req-obs-07--application-map-across-runs) | Application map across runs | implemented | could | 9 | 2/2 |
| [REQ-OBS-08](observability.md#req-obs-08--map-as-planner-input) | Map as planner input | accepted | could | later | 0/1 |
| [REQ-OBS-09](observability.md#req-obs-09--live-progress-of-a-run) | Live progress of a run | accepted | should | later | 0/4 |
| [REQ-CI-01](ci-cd.md#req-ci-01--ready-made-integrations) | Ready-made integrations | implemented | must | 10 | 3/3 |
| [REQ-CI-02](ci-cd.md#req-ci-02--triggers) | Triggers | implemented | should | 10 | 3/3 |
| [REQ-CI-03](ci-cd.md#req-ci-03--plan-approval-inside-the-pipeline) | Plan approval inside the pipeline | implemented | must | 10 | 4/4 |
| [REQ-CI-04](ci-cd.md#req-ci-04--outputs-for-pipelines) | Outputs for pipelines | implemented | must | 10 | 4/4 |
| [REQ-CI-05](ci-cd.md#req-ci-05--gradual-rollout-and-cost-control) | Gradual rollout and cost control | implemented | should | 10 | 3/3 |
| [REQ-GEN-01](generic.md#req-gen-01--project-onboarding-through-qa) | Project onboarding through `.qa/` | implemented | must | 1 | 3/3 |
| [REQ-GEN-02](generic.md#req-gen-02--adapter-interfaces) | Adapter interfaces | implemented | must | 1 | 3/3 |
| [REQ-GEN-03](generic.md#req-gen-03--init-and-doctor) | `init` and `doctor` | implemented | must | 9 | 3/3 |
| [REQ-GEN-04](generic.md#req-gen-04--claude-code-plugin-interface) | Claude Code plugin interface | implemented | could | 9 | 1/1 |
| [REQ-GEN-05](generic.md#req-gen-05--command-line) | Command line | implemented | must | 1 | 3/3 |
| [REQ-NFR-01](non-functional.md#req-nfr-01--code-standards) | Code standards | implemented | must | 1 | 3/3 |
| [REQ-NFR-02](non-functional.md#req-nfr-02--test-first-and-test-levels) | Test-first and test levels | implemented | must | 1 | 4/4 |
| [REQ-NFR-03](non-functional.md#req-nfr-03--documentation) | Documentation | implemented | must | 1 | 3/3 |
| [REQ-NFR-04](non-functional.md#req-nfr-04--framework-self-test) | Framework self-test | implemented | must | 3 | 2/2 |
| [REQ-NFR-05](non-functional.md#req-nfr-05--security-baseline) | Security baseline | implemented | must | 1 | 4/4 |
| [REQ-NFR-06](non-functional.md#req-nfr-06--open-source-and-contributor-experience) | Open source and contributor experience | implemented | must | 1 | 3/3 |
| [REQ-NFR-07](non-functional.md#req-nfr-07--platforms) | Platforms | implemented | should | 9 | 2/2 |
| [REQ-NFR-08](non-functional.md#req-nfr-08--ai-assisted-development-setup) | AI-assisted development setup | implemented | should | 1 | 3/3 |
| [REQ-PRJ-01](projects.md#req-prj-01--project-home-and-data-layout) | Project home and data layout | implemented | must | 2 | 5/5 |
| [REQ-PRJ-02](projects.md#req-prj-02--project-initialisation-qj-init) | Project initialisation (`qj init`) | implemented | must | 2 | 6/6 |
| [REQ-PRJ-03](projects.md#req-prj-03--active-project-and-switching) | Active project and switching | implemented | must | 2 | 7/7 |
| [REQ-PRJ-04](projects.md#req-prj-04--isolation-between-projects) | Isolation between projects | implemented | must | 2 | 4/4 |
| [REQ-PRJ-05](projects.md#req-prj-05--project-status-what-is-in-the-project-and-what-is-in-progress) | Project status: what is in the project and what is in progress | implemented | must | 3 | 5/5 |
| [REQ-PRJ-06](projects.md#req-prj-06--continue-after-switching) | Continue after switching | implemented | must | 3 | 3/3 |
| [REQ-PRJ-07](projects.md#req-prj-07--start-fresh-and-clean-up) | Start fresh and clean up | implemented | should | 6 | 5/5 |
| [REQ-PRJ-08](projects.md#req-prj-08--code-cache-per-project) | Code cache per project | implemented | should | 3 | 3/3 |
| [REQ-PRJ-09](projects.md#req-prj-09--export-and-import-of-a-project-profile) | Export and import of a project profile | implemented | could | later | 2/2 |
| [REQ-PRJ-10](projects.md#req-prj-10--evidence-reports-and-exports-stay-in-the-project) | Evidence, reports and exports stay in the project | implemented | must | 3 | 6/6 |
| [REQ-KNOW-01](knowledge.md#req-know-01--knowledge-base-per-project-created-on-demand) | Knowledge base per project, created on demand | implemented | should | 7 | 4/4 |
| [REQ-KNOW-02](knowledge.md#req-know-02--add-documents-from-files-and-folders) | Add documents from files and folders | implemented | should | 7 | 5/5 |
| [REQ-KNOW-03](knowledge.md#req-know-03--remove-documents-and-reset) | Remove documents and reset | implemented | should | 7 | 2/2 |
| [REQ-KNOW-04](knowledge.md#req-know-04--sync-with-changed-files) | Sync with changed files | implemented | should | 7 | 3/3 |
| [REQ-KNOW-05](knowledge.md#req-know-05--list-inspect-and-search) | List, inspect and search | implemented | should | 7 | 3/3 |
| [REQ-KNOW-06](knowledge.md#req-know-06--agent-access-with-sources) | Agent access with sources | implemented | should | 7 | 5/5 |
| [REQ-KNOW-07](knowledge.md#req-know-07--automatic-retrieval-mode) | Automatic retrieval mode | implemented | could | 7 | 3/3 |
| [REQ-KNOW-08](knowledge.md#req-know-08--embedding-model-and-storage-options) | Embedding model and storage options | implemented | should | 7 | 3/3 |
| [REQ-KNOW-09](knowledge.md#req-know-09--security-of-indexed-content) | Security of indexed content | implemented | must | 7 | 3/3 |
| [REQ-KNOW-10](knowledge.md#req-know-10--freshness-of-documentation) | Freshness of documentation | implemented | could | 7 | 2/2 |
| [REQ-KNOW-11](knowledge.md#req-know-11--measured-benefit) | Measured benefit | implemented | should | 7 | 1/1 |
| [REQ-KNOW-12](knowledge.md#req-know-12--online-sources) | Online sources | implemented | could | later | 2/2 |
<!-- req-index:end -->
<!-- prettier-ignore-end -->
