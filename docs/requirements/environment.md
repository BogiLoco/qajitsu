# Environments (ENV)

Where tests run: an environment the user provides, or one QAJitsu builds from the fetched repositories.

### REQ-ENV-01 · Provided environment

- Status: implemented
- Priority: must
- Stage: 3
- Related: INV-10, REQ-CFG-01

`--env <profile>` uses `.qa/envs/<profile>.yaml`; `--env <url>` uses a URL with the default profile's other settings.

**Acceptance criteria**

- [x] AC1: Health check before tests; an unreachable environment makes every case BLOCKED.
- [x] AC2: Environment allowlist applies to runners and agents; production hosts are denied unless explicitly allowed.
- [x] AC3: Account aliases, flags and URLs come from the profile.

### REQ-ENV-02 · Deployed version check

- Status: implemented
- Priority: should
- Stage: 3
- Related: REQ-CTX-04

QAJitsu warns when the environment does not run the code being tested.

**Acceptance criteria**

- [x] AC1: A configurable endpoint (e.g. `/version`) is read and its SHA compared with the change SHA.
- [x] AC2: Mismatch: interactive warning with confirm/abort; in CI a configurable fail or warn.
- [x] AC3: The deployed SHA is recorded in `run.json` and the report.

### REQ-ENV-03 · Build the environment from repositories

- Status: implemented
- Priority: must
- Stage: 6
- Related: REQ-CTX-04, REQ-WS-02, REQ-CFG-02

`--build` starts the application from the analysed worktrees.

**Acceptance criteria**

- [x] AC1: Docker Compose with the project's compose file plus a generated overlay: project name from the run id, dynamic ports, labels `qajitsu.ticket` and `qajitsu.run` on containers, networks and volumes.
- [x] AC2: Services without Docker run as managed processes from a configured command, logs to `logs/`.
- [x] AC3: Two runs can build in parallel without port or name clashes.

### REQ-ENV-04 · Readiness, seeding and start failures

- Status: implemented
- Priority: must
- Stage: 6
- Related: REQ-VER-01

**Acceptance criteria**

- [x] AC1: Health checks per service (HTTP status, open port, log line) with timeouts.
- [x] AC2: Optional seed hook (`.qa/hooks/seed.*`) runs after readiness.
- [x] AC3: Start failure: every case BLOCKED, service logs attached as evidence; agents may describe a probable cause but cannot mark tests as executed.

### REQ-ENV-05 · Stubs for external dependencies

- Status: implemented
- Priority: should
- Stage: 6
- Related: REQ-ENV-03

**Acceptance criteria**

- [x] AC1: A service can be declared as a stub (WireMock or Mockoon) with mappings in `.qa/stubs/`.
- [x] AC2: Stubbed services are listed in the report so readers know what was not real.

### REQ-ENV-06 · Mobile apps and devices

- Status: implemented
- Priority: must
- Stage: 8
- Related: REQ-EXEC-06, REQ-CTX-02

**Acceptance criteria**

- [x] AC1: App binaries (APK/IPA) are taken from CI artifacts for the change SHA (GitHub Actions, GitLab CI); building from source is optional.
- [x] AC2: Android emulators are started and stopped by QAJitsu.
- [x] AC3: iOS requires macOS or a device farm (BrowserStack, Sauce Labs, AWS Device Farm) as an EnvProvider; the limitation is reported clearly when unavailable.

### REQ-ENV-07 · Default environment selection

- Status: implemented
- Priority: should
- Stage: 3
- Related: REQ-ENV-01

**Acceptance criteria**

- [x] AC1: Without `--env` or `--build`, `environments.default` from project config is used (after the `qj env up` environment of AC3).
- [x] AC2: Without a default, interactive runs ask and CI runs fail with a configuration error.
- [x] AC3: Without `--env` or `--build`, a run whose environment `qj env up` started, and which still answers, uses it before `environments.default`; the run says so and journals it (`env.selected`). `--env` always wins.

### REQ-ENV-08 · Message capture: email, SMS and webhooks

- Status: implemented
- Priority: should
- Stage: later
- Related: INV-8, INV-10, REQ-ENV-05, REQ-CFG-07

Lets tests check registration emails, password resets, SMS codes and outgoing webhooks. The default adapter is
webhook.site (hosted or self-hosted); the provider sits behind an interface.

**Acceptance criteria**

- [x] AC1: Project config declares a message capture provider (webhook.site first); the run gets a unique inbox or URL per run and case.
- [x] AC2: Steps can wait for a message matching a filter (recipient, subject, body pattern) with a timeout; a timeout makes the step fail, never pass.
- [x] AC3: Received messages are stored as evidence after masking and listed in the manifest.
- [x] AC4: The provider host must be on the environment allowlist; the API token comes from a secret provider.
- [x] AC5: Inboxes created for a run are deleted at cleanup.

### REQ-ENV-09 · Account pools

- Status: implemented
- Priority: should
- Stage: later
- Related: INV-8, REQ-CFG-07, REQ-EXEC-10, REQ-EXEC-19

Cases running at the same time never interfere through a shared test account.

**Acceptance criteria**

- [x] AC1: An account alias in an environment profile can be a pool of accounts (`pool:`); a single account is a pool of one.
- [x] AC2: While a case runs it holds, for each alias its spec uses, one account of the pool for itself; no two cases running at the same time share an account unless the alias is marked `shared: true`.
- [x] AC3: A pool account can be limited to lanes (`lanes: [mobile]`), e.g. for apps that allow one session per user.
- [x] AC4: When no account is free the case waits up to `execution.account_wait_s`, then it is BLOCKED with the reason; it is never given an account in use.
- [x] AC5: The journal records which pool member each attempt used (`user:standard#2`, never the user name); `qj env check` warns when a pool is smaller than the number of cases that can need it at once.

### REQ-ENV-10 · Preview environments per change

- Status: proposed
- Priority: should
- Stage: 6
- Related: REQ-ENV-01, REQ-ENV-03, REQ-GEN-02

Besides a provided environment (REQ-ENV-01) and one built from the repositories (REQ-ENV-03), the environment of a change can be one an existing platform creates per pull or merge request.

**Acceptance criteria**

- [ ] AC1: Mode `preview`: the environment URL for the change is resolved through an environment provider adapter; first adapters: Vercel, Netlify, a Kubernetes namespace through Helm or Argo CD.
- [ ] AC2: QAJitsu never deploys, restarts or changes a preview environment; it only resolves and checks it (REQ-ENV-02).
- [ ] AC3: An environment that cannot be resolved makes every case BLOCKED with the reason.

### REQ-ENV-11 · DevOps agent: environment onboarding

- Status: proposed
- Priority: could
- Stage: 6
- Related: REQ-ENV-03, REQ-GEN-03, REQ-CTX-10

**Acceptance criteria**

- [ ] AC1: Optional, once per project: an agent reads the repository and CI files (Dockerfile, compose, pipeline config, README) when code access allows.
- [ ] AC2: It proposes an environment configuration and a seed script as files for review; nothing is executed before a person approves.
- [ ] AC3: After approval every run uses the approved configuration as code; the agent takes no part in normal runs.
- [ ] AC4: A change to an approved configuration needs a new approval.

### REQ-ENV-12 · Desktop test machines

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-EXEC-37, REQ-ENV-04, REQ-ENV-02

**Acceptance criteria**

- [ ] AC1: Desktop cases run on dedicated machines or virtual machines per operating system (Windows VMs, macOS hardware or macOS cloud hosts, Linux with a virtual display).
- [ ] AC2: The build under test is installed from the change's artifact and its version is checked before the tests, like REQ-ENV-02.
- [ ] AC3: Each run starts from a clean snapshot of the machine; the snapshot id is recorded in the run's journal.
- [ ] AC4: A machine that cannot be reached, restored or prepared makes the desktop cases BLOCKED with the reason.

### REQ-ENV-13 · Environment readiness for the ticket

- Status: accepted
- Priority: must
- Stage: later
- Related: REQ-ENV-02, REQ-ENV-10, REQ-FLOW-01, REQ-PLAN-13, REQ-VER-15, INV-1, INV-10

REQ-ENV-02 compares one SHA. Before testing a ticket, QAJitsu must be sure the environment runs exactly the change of
the ticket, with everything it needs, so a result is never about the wrong version.

**Acceptance criteria**

- [ ] AC1: For every repository of the ticket's change, the deployed version of its service is read (version endpoint, deployment API of GitHub, GitLab or Argo CD, container image labels) and checked: the change's commit is the deployed commit or one of its ancestors (a merged change); a missing or older version is a named mismatch.
- [ ] AC2: Configurable readiness checks run before the first case: health of every service, database migrations of the change applied, feature flags the ticket needs switched on, test accounts able to log in, dependencies reachable or mocked.
- [ ] AC3: The result is one environment readiness report (ready or not, per check with the observed value) in `run.json`, the report, the certificate and, as configured, a comment on the ticket.
- [ ] AC4: Not ready: no case runs; in the Jira workflow the ticket stays waiting with the reason, and QAJitsu can wait for the deployment by checking again at an interval up to a timeout before giving up as BLOCKED.
- [ ] AC5: A person can run anyway with a recorded reason; every result of that run is marked "environment not confirmed" in the report and the comment, and never counts as verified for the release (REQ-PUB-09).
- [ ] AC6: In pull mode (REQ-FLOW-01) a ticket is picked up only when its environment is ready, or picked up and parked until it is.
