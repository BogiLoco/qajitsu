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

- Status: accepted
- Priority: must
- Stage: 6
- Related: REQ-CTX-04, REQ-WS-02, REQ-CFG-02

`--build` starts the application from the analysed worktrees.

**Acceptance criteria**

- [ ] AC1: Docker Compose with the project's compose file plus a generated overlay: project name from the run id, dynamic ports, labels `qajitsu.ticket` and `qajitsu.run` on containers, networks and volumes.
- [ ] AC2: Services without Docker run as managed processes from a configured command, logs to `logs/`.
- [ ] AC3: Two runs can build in parallel without port or name clashes.

### REQ-ENV-04 · Readiness, seeding and start failures

- Status: accepted
- Priority: must
- Stage: 6
- Related: REQ-VER-01

**Acceptance criteria**

- [ ] AC1: Health checks per service (HTTP status, open port, log line) with timeouts.
- [ ] AC2: Optional seed hook (`.qa/hooks/seed.*`) runs after readiness.
- [ ] AC3: Start failure: every case BLOCKED, service logs attached as evidence; agents may describe a probable cause but cannot mark tests as executed.

### REQ-ENV-05 · Stubs for external dependencies

- Status: accepted
- Priority: should
- Stage: 6
- Related: REQ-ENV-03

**Acceptance criteria**

- [ ] AC1: A service can be declared as a stub (WireMock or Mockoon) with mappings in `.qa/stubs/`.
- [ ] AC2: Stubbed services are listed in the report so readers know what was not real.

### REQ-ENV-06 · Mobile apps and devices

- Status: accepted
- Priority: must
- Stage: 8
- Related: REQ-EXEC-06, REQ-CTX-02

**Acceptance criteria**

- [ ] AC1: App binaries (APK/IPA) are taken from CI artifacts for the change SHA (GitHub Actions, GitLab CI); building from source is optional.
- [ ] AC2: Android emulators are started and stopped by QAJitsu.
- [ ] AC3: iOS requires macOS or a device farm (BrowserStack, Sauce Labs, AWS Device Farm) as an EnvProvider; the limitation is reported clearly when unavailable.

### REQ-ENV-07 · Default environment selection

- Status: implemented
- Priority: should
- Stage: 3
- Related: REQ-ENV-01

**Acceptance criteria**

- [x] AC1: Without `--env` or `--build`, `environments.default` from project config is used.
- [x] AC2: Without a default, interactive runs ask and CI runs fail with a configuration error.
