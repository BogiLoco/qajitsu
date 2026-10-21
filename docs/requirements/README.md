# Requirements catalogue

This folder is the **source of truth for what QAJitsu must do**. Every feature, test, commit and PR traces back to a requirement id here.
The original planning document (`docs/plan.md`, Polish) explains the rationale; when the two disagree, this catalogue wins.

## Areas

| Prefix | File                                   | Scope                                                                      |
| ------ | -------------------------------------- | -------------------------------------------------------------------------- |
| CTX    | [context.md](context.md)               | Jira ticket, linked changes, GitHub/GitLab repositories, code access       |
| PLAN   | [plan.md](plan.md)                     | Analysis, test plan, approval and revisions                                |
| ENV    | [environment.md](environment.md)       | Existing environments, local builds, health checks, allowlists             |
| CFG    | [config-secrets.md](config-secrets.md) | Project config, variables, secrets, test accounts                          |
| WS     | [workspace.md](workspace.md)           | Run folders, unique ids, retention and cleanup                             |
| EXEC   | [execution.md](execution.md)           | Test authoring, runners (API, web, mobile), healing, retries               |
| VER    | [verification.md](verification.md)     | Anti-hallucination layer: statuses, guard, gates, auditor                  |
| EVD    | [evidence.md](evidence.md)             | Screenshots, videos, request/response, manifest, matrix                    |
| PUB    | [publishing.md](publishing.md)         | Jira comment, attachments, local report and video sharing                  |
| LLM    | [models.md](models.md)                 | Providers (cloud, LiteLLM, Ollama), roles, capabilities, costs             |
| OBS    | [observability.md](observability.md)   | Event log, log viewer, OpenTelemetry, transition graph                     |
| CI     | [ci-cd.md](ci-cd.md)                   | GitHub Actions, GitLab CI, approvals inside pipelines                      |
| GEN    | [generic.md](generic.md)               | Plugging into any project, adapters, CLI                                   |
| NFR    | [non-functional.md](non-functional.md) | Code standards, tests, docs, security, open source                         |
| PRJ    | [projects.md](projects.md)             | Projects on one machine: homes, switching, status, isolation               |
| KNOW   | [knowledge.md](knowledge.md)           | Knowledge base per project: add, sync, search, agent access                |
| FLOW   | [workflow.md](workflow.md)             | Jira workflow: start from a status, approval and transitions in the ticket |
| WEB    | [web.md](web.md)                       | Local web console: progress, details, plans, environments, chat            |
| AUTO   | [automation.md](automation.md)         | Promoted suite without models, candidates, triage, reproduction scripts    |
| PERF   | [performance.md](performance.md)       | Performance tests: frozen thresholds, runners, verdict from raw metrics    |
| SKILL  | [skills.md](skills.md)                 | Versioned agent skills: format, libraries, evaluation, maintenance         |
| TUNE   | [tuning.md](tuning.md)                 | Private model tuning on approved work (enterprise, later)                  |
| SCALE  | [scale.md](scale.md)                   | Tester farm: queue, workers, self-hosted, tenants, metering                |

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
252 requirements (91 proposed, 1 accepted, 2 in-progress, 154 implemented, 3 deferred, 1 deprecated); 580/975 acceptance criteria done.

| Id | Title | Status | Priority | Stage | AC done |
| --- | --- | --- | --- | --- | --- |
| [REQ-CTX-01](context.md#req-ctx-01--jira-ticket-as-the-input) | Jira ticket as the input | implemented | must | 1 | 5/5 |
| [REQ-CTX-02](context.md#req-ctx-02--github-and-gitlab-support) | GitHub and GitLab support | implemented | must | 1 | 4/4 |
| [REQ-CTX-03](context.md#req-ctx-03--change-discovery-for-a-ticket) | Change discovery for a ticket | implemented | must | 1 | 5/5 |
| [REQ-CTX-04](context.md#req-ctx-04--repositories-always-fetched-at-the-changes-version) | Repositories always fetched at the change's version | implemented | must | 1 | 4/4 |
| [REQ-CTX-05](context.md#req-ctx-05--code-analysis-context-for-agents) | Code analysis context for agents | implemented | must | 2 | 6/6 |
| [REQ-CTX-06](context.md#req-ctx-06--test-repository-awareness) | Test repository awareness | implemented | should | 3 | 5/5 |
| [REQ-CTX-07](context.md#req-ctx-07--project-knowledge-for-agents) | Project knowledge for agents | implemented | should | 2 | 2/2 |
| [REQ-CTX-08](context.md#req-ctx-08--import-existing-manual-test-cases) | Import existing manual test cases | implemented | could | later | 4/4 |
| [REQ-CTX-09](context.md#req-ctx-09--tickets-from-sources-other-than-jira) | Tickets from sources other than Jira | proposed | should | 9 | 0/5 |
| [REQ-CTX-10](context.md#req-ctx-10--code-access-levels) | Code access levels | proposed | must | 3 | 0/4 |
| [REQ-PLAN-01](plan.md#req-plan-01--change-analysis-and-classification) | Change analysis and classification | implemented | must | 2 | 3/3 |
| [REQ-PLAN-02](plan.md#req-plan-02--structured-test-plan) | Structured test plan | implemented | must | 2 | 4/4 |
| [REQ-PLAN-03](plan.md#req-plan-03--grounded-sources) | Grounded sources | implemented | must | 2 | 2/2 |
| [REQ-PLAN-04](plan.md#req-plan-04--human-review-loop) | Human review loop | implemented | must | 2 | 3/3 |
| [REQ-PLAN-05](plan.md#req-plan-05--open-questions-instead-of-guessing) | Open questions instead of guessing | implemented | must | 2 | 2/2 |
| [REQ-PLAN-06](plan.md#req-plan-06--plan-freeze) | Plan freeze | implemented | must | 2 | 4/4 |
| [REQ-PLAN-07](plan.md#req-plan-07--approval-channels) | Approval channels | deferred | should | 10 | 3/4 |
| [REQ-PLAN-08](plan.md#req-plan-08--test-depth-and-budget) | Test depth and budget | implemented | should | later | 4/4 |
| [REQ-PLAN-09](plan.md#req-plan-09--concrete-expected-values) | Concrete expected values | implemented | must | 2 | 9/9 |
| [REQ-PLAN-10](plan.md#req-plan-10--approval-by-a-person-or-by-models-auditable) | Approval by a person or by models, auditable | implemented | could | later | 6/6 |
| [REQ-PLAN-11](plan.md#req-plan-11--exploration-before-planning-accepted-by-a-person) | Exploration before planning, accepted by a person | implemented | should | later | 8/8 |
| [REQ-PLAN-12](plan.md#req-plan-12--numbers-written-as-text-in-expectations-converted-by-code) | Numbers written as text in expectations, converted by code | implemented | should | later | 4/4 |
| [REQ-PLAN-13](plan.md#req-plan-13--ticket-readiness-gate) | Ticket readiness gate | proposed | should | 2 | 0/6 |
| [REQ-PLAN-14](plan.md#req-plan-14--coverage-matrix-computed-by-code) | Coverage matrix computed by code | implemented | must | 2 | 4/4 |
| [REQ-PLAN-15](plan.md#req-plan-15--project-lessons-from-revisions) | Project lessons from revisions | proposed | should | 7 | 0/4 |
| [REQ-PLAN-16](plan.md#req-plan-16--plan-quality-metrics) | Plan quality metrics | proposed | should | 7 | 0/3 |
| [REQ-ENV-01](environment.md#req-env-01--provided-environment) | Provided environment | implemented | must | 3 | 3/3 |
| [REQ-ENV-02](environment.md#req-env-02--deployed-version-check) | Deployed version check | implemented | should | 3 | 3/3 |
| [REQ-ENV-03](environment.md#req-env-03--build-the-environment-from-repositories) | Build the environment from repositories | implemented | must | 6 | 3/3 |
| [REQ-ENV-04](environment.md#req-env-04--readiness-seeding-and-start-failures) | Readiness, seeding and start failures | implemented | must | 6 | 3/3 |
| [REQ-ENV-05](environment.md#req-env-05--stubs-for-external-dependencies) | Stubs for external dependencies | implemented | should | 6 | 2/2 |
| [REQ-ENV-06](environment.md#req-env-06--mobile-apps-and-devices) | Mobile apps and devices | implemented | must | 8 | 3/3 |
| [REQ-ENV-07](environment.md#req-env-07--default-environment-selection) | Default environment selection | implemented | should | 3 | 3/3 |
| [REQ-ENV-08](environment.md#req-env-08--message-capture-email-sms-and-webhooks) | Message capture: email, SMS and webhooks | implemented | should | later | 5/5 |
| [REQ-ENV-09](environment.md#req-env-09--account-pools) | Account pools | implemented | should | later | 5/5 |
| [REQ-ENV-10](environment.md#req-env-10--preview-environments-per-change) | Preview environments per change | proposed | should | 6 | 0/3 |
| [REQ-ENV-11](environment.md#req-env-11--devops-agent-environment-onboarding) | DevOps agent: environment onboarding | proposed | could | 6 | 0/4 |
| [REQ-ENV-12](environment.md#req-env-12--desktop-test-machines) | Desktop test machines | proposed | could | later | 0/4 |
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
| [REQ-EXEC-03](execution.md#req-exec-03--static-checks-before-execution) | Static checks before execution | implemented | must | 3 | 5/5 |
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
| [REQ-EXEC-15](execution.md#req-exec-15--exploratory-sessions) | Exploratory sessions | implemented | could | later | 10/10 |
| [REQ-EXEC-16](execution.md#req-exec-16--run-one-case-with-a-live-view) | Run one case with a live view | implemented | should | later | 4/4 |
| [REQ-EXEC-17](execution.md#req-exec-17--regression-runs-of-promoted-packs) | Regression runs of promoted packs | implemented | should | later | 4/4 |
| [REQ-EXEC-18](execution.md#req-exec-18--compare-the-ui-with-the-design-in-figma) | Compare the UI with the design in Figma | accepted | could | later | 0/4 |
| [REQ-EXEC-19](execution.md#req-exec-19--execution-lanes-and-sequential-runs) | Execution lanes and sequential runs | implemented | should | later | 5/5 |
| [REQ-EXEC-20](execution.md#req-exec-20--several-different-mobile-devices) | Several different mobile devices | implemented | should | later | 5/5 |
| [REQ-EXEC-21](execution.md#req-exec-21--selectors-for-any-web-or-mobile-application) | Selectors for any web or mobile application | implemented | must | later | 7/7 |
| [REQ-EXEC-22](execution.md#req-exec-22--snapshot-of-the-running-application-for-the-author-and-the-healer) | Snapshot of the running application for the author and the healer | implemented | must | later | 9/9 |
| [REQ-EXEC-23](execution.md#req-exec-23--mobile-app-without-access-to-its-code) | Mobile app without access to its code | implemented | should | later | 3/3 |
| [REQ-EXEC-24](execution.md#req-exec-24--exploratory-sessions-of-command-line-tools) | Exploratory sessions of command-line tools | implemented | should | later | 11/11 |
| [REQ-EXEC-25](execution.md#req-exec-25--grounded-reports-of-exploratory-sessions) | Grounded reports of exploratory sessions | implemented | should | later | 10/10 |
| [REQ-EXEC-26](execution.md#req-exec-26--poor-network-conditions) | Poor network conditions | proposed | could | later | 0/2 |
| [REQ-EXEC-27](execution.md#req-exec-27--document-verification) | Document verification | proposed | could | later | 0/2 |
| [REQ-EXEC-28](execution.md#req-exec-28--audio-voice-and-ivr) | Audio, voice and IVR | proposed | could | later | 0/3 |
| [REQ-EXEC-29](execution.md#req-exec-29--testing-ai-features) | Testing AI features | proposed | should | 9 | 0/6 |
| [REQ-EXEC-30](execution.md#req-exec-30--llm-judge-that-can-only-downgrade) | LLM judge that can only downgrade | proposed | should | 9 | 0/9 |
| [REQ-EXEC-31](execution.md#req-exec-31--judge-calibration-and-drift-control) | Judge calibration and drift control | proposed | should | 9 | 0/4 |
| [REQ-EXEC-32](execution.md#req-exec-32--evaluation-of-retrieval-augmented-answers) | Evaluation of retrieval-augmented answers | proposed | could | 9 | 0/3 |
| [REQ-EXEC-33](execution.md#req-exec-33--behaviour-regression-after-model-or-prompt-changes) | Behaviour regression after model or prompt changes | proposed | should | 9 | 0/3 |
| [REQ-EXEC-34](execution.md#req-exec-34--llm-evaluation-tools-as-runners) | LLM evaluation tools as runners | proposed | could | later | 0/3 |
| [REQ-EXEC-35](execution.md#req-exec-35--external-runner-integrations) | External runner integrations | proposed | could | later | 0/3 |
| [REQ-EXEC-36](execution.md#req-exec-36--blockchain-evm-application-testing) | Blockchain (EVM) application testing | proposed | could | later | 0/5 |
| [REQ-EXEC-37](execution.md#req-exec-37--desktop-application-testing) | Desktop application testing | proposed | could | later | 0/6 |
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
| [REQ-VER-13](verification.md#req-ver-13--why-a-case-was-blocked) | Why a case was BLOCKED | implemented | should | later | 3/3 |
| [REQ-VER-14](verification.md#req-ver-14--mutation-check-of-a-change) | Mutation check of a change | proposed | could | later | 0/11 |
| [REQ-VER-15](verification.md#req-ver-15--verifiable-test-certificate) | Verifiable test certificate | proposed | should | 9 | 0/7 |
| [REQ-VER-16](verification.md#req-ver-16--complete-audit-trail) | Complete audit trail | proposed | must | 3 | 0/5 |
| [REQ-VER-17](verification.md#req-ver-17--trusted-timestamps) | Trusted timestamps | proposed | should | 9 | 0/5 |
| [REQ-VER-18](verification.md#req-ver-18--public-and-private-transparency-logs) | Public and private transparency logs | proposed | could | later | 0/4 |
| [REQ-VER-19](verification.md#req-ver-19--immutable-evidence-storage) | Immutable evidence storage | proposed | should | 9 | 0/3 |
| [REQ-VER-20](verification.md#req-ver-20--reproduce-a-run-from-its-certificate) | Reproduce a run from its certificate | proposed | should | 9 | 0/3 |
| [REQ-VER-21](verification.md#req-ver-21--open-verifier-and-audit-documentation) | Open verifier and audit documentation | proposed | should | 9 | 0/3 |
| [REQ-VER-22](verification.md#req-ver-22--cross-layer-consistency-checks) | Cross-layer consistency checks | proposed | could | later | 0/3 |
| [REQ-EVD-01](evidence.md#req-evd-01--api-evidence) | API evidence | implemented | must | 3 | 3/3 |
| [REQ-EVD-02](evidence.md#req-evd-02--web-evidence) | Web evidence | implemented | must | 5 | 3/3 |
| [REQ-EVD-03](evidence.md#req-evd-03--mobile-evidence) | Mobile evidence | implemented | must | 8 | 3/3 |
| [REQ-EVD-04](evidence.md#req-evd-04--test-matrix) | Test matrix | implemented | must | 3 | 3/3 |
| [REQ-EVD-05](evidence.md#req-evd-05--report-formats) | Report formats | implemented | must | 3 | 3/3 |
| [REQ-EVD-06](evidence.md#req-evd-06--media-policy) | Media policy | implemented | should | 5 | 2/2 |
| [REQ-EVD-07](evidence.md#req-evd-07--passive-observations-during-tests) | Passive observations during tests | implemented | should | later | 5/5 |
| [REQ-EVD-08](evidence.md#req-evd-08--failure-screenshots-mark-the-failing-element) | Failure screenshots mark the failing element | implemented | should | later | 5/5 |
| [REQ-PUB-01](publishing.md#req-pub-01--jira-comment) | Jira comment | implemented | must | 4 | 4/4 |
| [REQ-PUB-02](publishing.md#req-pub-02--attachments) | Attachments | deferred | must | 4 | 2/3 |
| [REQ-PUB-03](publishing.md#req-pub-03--jira-cloud-and-data-center) | Jira Cloud and Data Center | implemented | should | 4 | 2/2 |
| [REQ-PUB-04](publishing.md#req-pub-04--idempotent-publishing) | Idempotent publishing | implemented | must | 4 | 2/2 |
| [REQ-PUB-05](publishing.md#req-pub-05--optional-integrations) | Optional integrations | deferred | could | later | 1/4 |
| [REQ-PUB-06](publishing.md#req-pub-06--failure-videos-and-evidence-for-the-user) | Failure videos and evidence for the user | implemented | must | 5 | 3/3 |
| [REQ-PUB-07](publishing.md#req-pub-07--bug-reports-from-failed-cases) | Bug reports from failed cases | implemented | should | later | 5/5 |
| [REQ-PUB-08](publishing.md#req-pub-08--promote-ticket-cases-to-the-regression-suite) | Promote ticket cases to the regression suite | implemented | should | later | 4/4 |
| [REQ-PUB-09](publishing.md#req-pub-09--release-readiness-report) | Release readiness report | implemented | could | later | 4/4 |
| [REQ-PUB-10](publishing.md#req-pub-10--go--no-go-decision-computed-from-the-matrix) | GO / NO-GO decision computed from the matrix | implemented | should | 4 | 5/5 |
| [REQ-LLM-01](models.md#req-llm-01--multiple-providers) | Multiple providers | implemented | must | 2 | 7/7 |
| [REQ-LLM-02](models.md#req-llm-02--model-per-role) | Model per role | implemented | must | 2 | 2/2 |
| [REQ-LLM-03](models.md#req-llm-03--capability-profiles) | Capability profiles | implemented | must | 2 | 3/3 |
| [REQ-LLM-04](models.md#req-llm-04--structured-output-with-repair) | Structured output with repair | implemented | must | 2 | 3/3 |
| [REQ-LLM-05](models.md#req-llm-05--local-models-used-honestly) | Local models used honestly | implemented | should | 7 | 2/2 |
| [REQ-LLM-06](models.md#req-llm-06--model-benchmark) | Model benchmark | implemented | should | 7 | 3/3 |
| [REQ-LLM-07](models.md#req-llm-07--cost-and-token-tracking) | Cost and token tracking | implemented | should | 2 | 2/2 |
| [REQ-LLM-08](models.md#req-llm-08--claude-code-subscription-as-a-local-model-provider) | Claude Code subscription as a local model provider | deprecated | could | later | 0/6 |
| [REQ-LLM-09](models.md#req-llm-09--start-with-an-api-key-only) | Start with an API key only | implemented | should | later | 6/6 |
| [REQ-LLM-10](models.md#req-llm-10--model-profiles-from-gateways-litellm-openrouter) | Model profiles from gateways (LiteLLM, OpenRouter) | proposed | could | later | 0/4 |
| [REQ-LLM-11](models.md#req-llm-11--cost-per-verified-ticket) | Cost per verified ticket | proposed | should | 2 | 0/4 |
| [REQ-LLM-12](models.md#req-llm-12--provider-cost-features-prompt-caching-and-batches) | Provider cost features: prompt caching and batches | proposed | should | 3 | 0/5 |
| [REQ-LLM-13](models.md#req-llm-13--model-routing-proposals-from-data) | Model routing proposals from data | proposed | could | 7 | 0/3 |
| [REQ-OBS-01](observability.md#req-obs-01--structured-event-log-per-run) | Structured event log per run | implemented | must | 1 | 2/2 |
| [REQ-OBS-02](observability.md#req-obs-02--viewing-logs) | Viewing logs | implemented | must | 5 | 3/3 |
| [REQ-OBS-03](observability.md#req-obs-03--opentelemetry-export) | OpenTelemetry export | implemented | should | 9 | 2/2 |
| [REQ-OBS-04](observability.md#req-obs-04--metrics-dashboards-and-alerts) | Metrics, dashboards and alerts | implemented | could | 9 | 3/3 |
| [REQ-OBS-05](observability.md#req-obs-05--tamper-evident-audit-log) | Tamper-evident audit log | implemented | should | 9 | 2/2 |
| [REQ-OBS-06](observability.md#req-obs-06--transition-graph-per-run) | Transition graph per run | implemented | should | 5 | 3/3 |
| [REQ-OBS-07](observability.md#req-obs-07--application-map-across-runs) | Application map across runs | implemented | could | 9 | 2/2 |
| [REQ-OBS-08](observability.md#req-obs-08--map-as-planner-input) | Map as planner input | implemented | could | later | 1/1 |
| [REQ-OBS-09](observability.md#req-obs-09--live-progress-of-a-run) | Live progress of a run | implemented | should | later | 4/4 |
| [REQ-OBS-10](observability.md#req-obs-10--tool-versions-recorded-with-every-run) | Tool versions recorded with every run | implemented | should | later | 4/4 |
| [REQ-OBS-11](observability.md#req-obs-11--run-replay) | Run replay | proposed | could | later | 0/2 |
| [REQ-CI-01](ci-cd.md#req-ci-01--ready-made-integrations) | Ready-made integrations | implemented | must | 10 | 3/3 |
| [REQ-CI-02](ci-cd.md#req-ci-02--triggers) | Triggers | implemented | should | 10 | 3/3 |
| [REQ-CI-03](ci-cd.md#req-ci-03--plan-approval-inside-the-pipeline) | Plan approval inside the pipeline | implemented | must | 10 | 4/4 |
| [REQ-CI-04](ci-cd.md#req-ci-04--outputs-for-pipelines) | Outputs for pipelines | implemented | must | 10 | 4/4 |
| [REQ-CI-05](ci-cd.md#req-ci-05--gradual-rollout-and-cost-control) | Gradual rollout and cost control | implemented | should | 10 | 3/3 |
| [REQ-CI-06](ci-cd.md#req-ci-06--toolchain-in-pipelines) | Toolchain in pipelines | in-progress | could | later | 1/2 |
| [REQ-GEN-01](generic.md#req-gen-01--project-onboarding-through-qa) | Project onboarding through `.qa/` | implemented | must | 1 | 3/3 |
| [REQ-GEN-02](generic.md#req-gen-02--adapter-interfaces) | Adapter interfaces | implemented | must | 1 | 3/3 |
| [REQ-GEN-03](generic.md#req-gen-03--init-and-doctor) | `init` and `doctor` | implemented | must | 9 | 5/5 |
| [REQ-GEN-04](generic.md#req-gen-04--claude-code-plugin-interface) | Claude Code plugin interface | implemented | could | 9 | 1/1 |
| [REQ-GEN-05](generic.md#req-gen-05--command-line) | Command line | implemented | must | 1 | 3/3 |
| [REQ-GEN-06](generic.md#req-gen-06--toolchain-setup) | Toolchain setup | implemented | should | later | 9/9 |
| [REQ-GEN-07](generic.md#req-gen-07--external-agent-mode-claude-code-subagents-do-the-agents-work) | External agent mode: Claude Code subagents do the agents' work | proposed | should | later | 0/6 |
| [REQ-GEN-08](generic.md#req-gen-08--consistent-doctor-output-and-exit-codes) | Consistent `doctor` output and exit codes | implemented | should | later | 3/3 |
| [REQ-GEN-09](generic.md#req-gen-09--signed-release-images) | Signed release images | proposed | should | 3 | 0/6 |
| [REQ-GEN-10](generic.md#req-gen-10--ready-to-run-images-and-a-compose-stack) | Ready-to-run images and a Compose stack | proposed | should | 9 | 0/6 |
| [REQ-GEN-11](generic.md#req-gen-11--integrations-as-plugins-installed-on-demand) | Integrations as plugins, installed on demand | proposed | should | 9 | 0/9 |
| [REQ-GEN-12](generic.md#req-gen-12--plugin-tiers-dev-kit-and-registry) | Plugin tiers, dev kit and registry | proposed | could | later | 0/9 |
| [REQ-NFR-01](non-functional.md#req-nfr-01--code-standards) | Code standards | implemented | must | 1 | 3/3 |
| [REQ-NFR-02](non-functional.md#req-nfr-02--test-first-and-test-levels) | Test-first and test levels | implemented | must | 1 | 4/4 |
| [REQ-NFR-03](non-functional.md#req-nfr-03--documentation) | Documentation | implemented | must | 1 | 3/3 |
| [REQ-NFR-04](non-functional.md#req-nfr-04--framework-self-test) | Framework self-test | implemented | must | 3 | 2/2 |
| [REQ-NFR-05](non-functional.md#req-nfr-05--security-baseline) | Security baseline | implemented | must | 1 | 4/4 |
| [REQ-NFR-06](non-functional.md#req-nfr-06--open-source-and-contributor-experience) | Open source and contributor experience | implemented | must | 1 | 3/3 |
| [REQ-NFR-07](non-functional.md#req-nfr-07--platforms) | Platforms | implemented | should | 9 | 2/2 |
| [REQ-NFR-08](non-functional.md#req-nfr-08--ai-assisted-development-setup) | AI-assisted development setup | implemented | should | 1 | 3/3 |
| [REQ-NFR-09](non-functional.md#req-nfr-09--exploratory-pass-over-every-command-before-a-release) | Exploratory pass over every command before a release | implemented | should | later | 4/4 |
| [REQ-NFR-10](non-functional.md#req-nfr-10--a-merge-needs-green-ci-on-the-nodejs-version-ci-uses) | A merge needs green CI, on the Node.js version CI uses | in-progress | must | later | 3/4 |
| [REQ-NFR-11](non-functional.md#req-nfr-11--stage-timing-budgets-and-profiling) | Stage timing, budgets and profiling | proposed | should | 5 | 0/5 |
| [REQ-NFR-12](non-functional.md#req-nfr-12--pipeline-speed-by-design) | Pipeline speed by design | proposed | should | 6 | 0/7 |
| [REQ-NFR-13](non-functional.md#req-nfr-13--native-components-for-trust-critical-and-heavy-processing) | Native components for trust-critical and heavy processing | proposed | could | 9 | 0/6 |
| [REQ-PRJ-01](projects.md#req-prj-01--project-home-and-data-layout) | Project home and data layout | implemented | must | 2 | 5/5 |
| [REQ-PRJ-02](projects.md#req-prj-02--project-initialisation-qj-init) | Project initialisation (`qj init`) | implemented | must | 2 | 6/6 |
| [REQ-PRJ-03](projects.md#req-prj-03--active-project-and-switching) | Active project and switching | implemented | must | 2 | 7/7 |
| [REQ-PRJ-04](projects.md#req-prj-04--isolation-between-projects) | Isolation between projects | implemented | must | 2 | 4/4 |
| [REQ-PRJ-05](projects.md#req-prj-05--project-status-what-is-in-the-project-and-what-is-in-progress) | Project status: what is in the project and what is in progress | implemented | must | 3 | 6/6 |
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
| [REQ-FLOW-01](workflow.md#req-flow-01--start-from-a-jira-status) | Start from a Jira status | proposed | should | 10 | 0/4 |
| [REQ-FLOW-02](workflow.md#req-flow-02--status-mapping-per-project) | Status mapping per project | proposed | must | 10 | 0/3 |
| [REQ-FLOW-03](workflow.md#req-flow-03--plan-approval-in-the-ticket) | Plan approval in the ticket | proposed | must | 10 | 0/7 |
| [REQ-FLOW-04](workflow.md#req-flow-04--transition-policy-from-the-verdict) | Transition policy from the verdict | proposed | must | 10 | 0/5 |
| [REQ-FLOW-05](workflow.md#req-flow-05--one-run-per-ticket-and-loop-limits) | One run per ticket and loop limits | proposed | must | 10 | 0/3 |
| [REQ-FLOW-06](workflow.md#req-flow-06--cost-budget-per-ticket-and-per-month) | Cost budget per ticket and per month | proposed | should | 10 | 0/2 |
| [REQ-FLOW-07](workflow.md#req-flow-07--run-commands-in-ticket-comments) | Run commands in ticket comments | proposed | should | 10 | 0/4 |
| [REQ-FLOW-08](workflow.md#req-flow-08--qa-result-field-and-labels-in-jira) | QA result field and labels in Jira | proposed | should | 10 | 0/3 |
| [REQ-FLOW-09](workflow.md#req-flow-09--ticket-actions-from-the-web-console) | Ticket actions from the web console | proposed | should | 10 | 0/3 |
| [REQ-FLOW-10](workflow.md#req-flow-10--human-qa-partners-on-demand) | Human QA partners on demand | proposed | could | later | 0/7 |
| [REQ-WEB-01](web.md#req-web-01--local-web-console) | Local web console | proposed | should | 5 | 0/3 |
| [REQ-WEB-02](web.md#req-web-02--gamified-dojo-avatar) | Gamified dojo avatar | proposed | could | later | 0/5 |
| [REQ-WEB-03](web.md#req-web-03--outcome-reactions-during-execution) | Outcome reactions during execution | proposed | could | later | 0/9 |
| [REQ-WEB-04](web.md#req-web-04--dojo-mode-and-professional-mode) | Dojo mode and Professional mode | proposed | should | 5 | 0/6 |
| [REQ-WEB-05](web.md#req-web-05--run-details-live-steps-and-logs) | Run details: live steps and logs | proposed | should | 5 | 0/5 |
| [REQ-WEB-06](web.md#req-web-06--environment-management-screen) | Environment management screen | proposed | should | 6 | 0/5 |
| [REQ-WEB-07](web.md#req-web-07--plan-review-screen) | Plan review screen | proposed | should | 5 | 0/3 |
| [REQ-WEB-08](web.md#req-web-08--contextual-chat) | Contextual chat | proposed | could | 7 | 0/5 |
| [REQ-WEB-09](web.md#req-web-09--chat-actions-are-proposals) | Chat actions are proposals | proposed | must | 7 | 0/3 |
| [REQ-WEB-10](web.md#req-web-10--shareable-run-summary) | Shareable run summary | proposed | could | later | 0/2 |
| [REQ-AUTO-01](automation.md#req-auto-01--automation-candidates-ranked-by-value) | Automation candidates ranked by value | proposed | should | 10 | 0/3 |
| [REQ-AUTO-02](automation.md#req-auto-02--failure-triage-by-reproduction) | Failure triage by reproduction | proposed | should | 10 | 0/6 |
| [REQ-AUTO-03](automation.md#req-auto-03--suite-maintenance) | Suite maintenance | proposed | could | later | 0/3 |
| [REQ-AUTO-04](automation.md#req-auto-04--portable-bug-reproduction-scripts) | Portable bug reproduction scripts | proposed | should | 10 | 0/5 |
| [REQ-PERF-01](performance.md#req-perf-01--performance-plan-with-frozen-thresholds) | Performance plan with frozen thresholds | proposed | should | later | 0/3 |
| [REQ-PERF-02](performance.md#req-perf-02--tool-agnostic-performance-runners) | Tool-agnostic performance runners | proposed | should | later | 0/4 |
| [REQ-PERF-03](performance.md#req-perf-03--verdict-from-raw-metrics) | Verdict from raw metrics | proposed | must | later | 0/3 |
| [REQ-PERF-04](performance.md#req-perf-04--baselines-and-trends) | Baselines and trends | proposed | should | later | 0/3 |
| [REQ-PERF-05](performance.md#req-perf-05--safe-load-generation) | Safe load generation | proposed | must | later | 0/3 |
| [REQ-PERF-06](performance.md#req-perf-06--performance-evidence) | Performance evidence | proposed | should | later | 0/2 |
| [REQ-SKILL-01](skills.md#req-skill-01--skill-format-and-progressive-loading) | Skill format and progressive loading | proposed | should | 7 | 0/4 |
| [REQ-SKILL-02](skills.md#req-skill-02--general-and-project-skill-libraries) | General and project skill libraries | proposed | should | 7 | 0/3 |
| [REQ-SKILL-03](skills.md#req-skill-03--skill-candidates-from-approved-work) | Skill candidates from approved work | proposed | could | 9 | 0/4 |
| [REQ-SKILL-04](skills.md#req-skill-04--skill-evaluation-gate-quality-first-then-cost) | Skill evaluation gate: quality first, then cost | proposed | must | 9 | 0/4 |
| [REQ-SKILL-05](skills.md#req-skill-05--model-specific-skill-variants) | Model-specific skill variants | proposed | could | 9 | 0/3 |
| [REQ-SKILL-06](skills.md#req-skill-06--skill-review-signing-and-traceability) | Skill review, signing and traceability | proposed | must | 7 | 0/3 |
| [REQ-SKILL-07](skills.md#req-skill-07--skill-maintenance) | Skill maintenance | proposed | should | 9 | 0/4 |
| [REQ-TUNE-01](tuning.md#req-tune-01--training-data-from-the-audit-trail-with-consent) | Training data from the audit trail, with consent | proposed | should | later | 0/4 |
| [REQ-TUNE-02](tuning.md#req-tune-02--tuning-cycle-with-a-gate-and-shadow-mode) | Tuning cycle with a gate and shadow mode | proposed | could | later | 0/5 |
| [REQ-TUNE-03](tuning.md#req-tune-03--training-providers-and-data-residency) | Training providers and data residency | proposed | must | later | 0/3 |
| [REQ-TUNE-04](tuning.md#req-tune-04--shared-base-model-with-per-tenant-adapters) | Shared base model with per-tenant adapters | proposed | could | later | 0/2 |
| [REQ-TUNE-05](tuning.md#req-tune-05--licences-of-base-models) | Licences of base models | proposed | must | later | 0/2 |
| [REQ-SCALE-01](scale.md#req-scale-01--control-plane-and-run-queue) | Control plane and run queue | proposed | should | later | 0/3 |
| [REQ-SCALE-02](scale.md#req-scale-02--worker-pool-and-autoscaling) | Worker pool and autoscaling | proposed | should | later | 0/3 |
| [REQ-SCALE-03](scale.md#req-scale-03--self-hosted-worker) | Self-hosted worker | proposed | must | later | 0/2 |
| [REQ-SCALE-04](scale.md#req-scale-04--tenant-isolation) | Tenant isolation | proposed | must | later | 0/2 |
| [REQ-SCALE-05](scale.md#req-scale-05--bring-your-own-key) | Bring your own key | proposed | should | later | 0/2 |
| [REQ-SCALE-06](scale.md#req-scale-06--metering-and-cost-limits) | Metering and cost limits | proposed | should | later | 0/2 |
| [REQ-SCALE-07](scale.md#req-scale-07--specialist-planners) | Specialist planners | proposed | could | later | 0/3 |
<!-- req-index:end -->
<!-- prettier-ignore-end -->
