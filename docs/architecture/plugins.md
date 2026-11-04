# Plugin inventory

Requirement: REQ-GEN-14. Decision record: ADR-0011. Status (2026-11-01): **accepted** by the project owner: the
split between core and plugins and the migration order below (AC4) are the basis for REQ-GEN-11.

This page lists every integration QAJitsu has or plans: every package under `packages/adapters/`, and every
integration a requirement names. It exists so the plugin types, the interfaces and the packaging of REQ-GEN-11 fit all
of them before any adapter moves out of the core installation.

`pnpm req:check` keeps the page current (REQ-GEN-14/AC5). It fails when:

- a package under `packages/adapters/` is missing;
- a requirement names an integration that no entry lists in its `Names` (the watched names are `WATCHED_NAMES` in
  `scripts/plugin-inventory.mjs`; add a name there when a requirement starts naming a new product);
- an entry is incomplete, uses an unknown type, status, tier or placement, names an interface `@qajitsu/core` does not
  export, a package that does not exist or a requirement that does not exist;
- the summary table is stale. `pnpm req:index` regenerates it.

## Summary

<!-- prettier-ignore-start -->
<!-- plugin-index:start -->
| Plugin | Type | Interface | Status | Placement | Tier |
| --- | --- | --- | --- | --- | --- |
| [Jira Cloud and Data Center](#jira-cloud-and-data-center) | ticket source, publisher, ticket workflow, bug tracker, document source | TicketSource, Publisher, TicketWorkflow, BugTracker, DocumentSource | exists | plugin | official open source |
| [Xray](#xray) | test-case source, publisher | TestCaseSource, new ResultImporter (ADR before implementation) | exists | plugin | official open source |
| [Zephyr Scale](#zephyr-scale) | test-case source, publisher | TestCaseSource, new ResultImporter (ADR before implementation) | exists | plugin | official open source |
| [Zephyr Squad](#zephyr-squad) | test-case source, publisher | TestCaseSource, new ResultImporter (ADR before implementation) | idea | plugin | official open source |
| [TestRail](#testrail) | test-case source, publisher | TestCaseSource, new ResultImporter (ADR before implementation) | exists | plugin | official open source |
| [qTest](#qtest) | test-case source, publisher | TestCaseSource, new ResultImporter (ADR before implementation) | idea | plugin | official commercial |
| [Azure DevOps Boards and Test Plans](#azure-devops-boards-and-test-plans) | ticket source, test-case source, ticket workflow, publisher | TicketSource, TestCaseSource, TicketWorkflow, Publisher | idea | plugin | official open source |
| [Linear](#linear) | ticket source, ticket workflow | TicketSource, TicketWorkflow | idea | plugin | official open source |
| [Notion](#notion) | ticket source, document source | TicketSource, DocumentSource | idea | plugin | official open source |
| [Local files](#local-files) | ticket source, ticket workflow, publisher, bug tracker, document source, test-case source | TicketSource, TicketWorkflow, Publisher, BugTracker, DocumentSource, TestCaseSource | exists | core | official open source |
| [GitHub and GitHub Enterprise Server](#github-and-github-enterprise-server) | code host | CodeHost | exists | plugin | official open source |
| [GitLab](#gitlab) | code host | CodeHost | exists | plugin | official open source |
| [Local git repositories](#local-git-repositories) | code host | CodeHost | exists | core | official open source |
| [Bitbucket Cloud and Data Center](#bitbucket-cloud-and-data-center) | code host | CodeHost | idea | plugin | official open source |
| [Azure Repos](#azure-repos) | code host | CodeHost | idea | plugin | official open source |
| [API runner](#api-runner) | runner, test data | AttemptExecutor, TestDataProvider | exists | plugin | official open source |
| [Web runner](#web-runner) | runner | AttemptExecutor | exists | plugin | official open source |
| [Mobile runner (Appium)](#mobile-runner-appium) | runner | AttemptExecutor | exists | plugin | official open source |
| [Device farms](#device-farms) | device provider | new DeviceProvider (ADR before implementation) | exists | plugin | partner |
| [Maestro](#maestro) | runner | AttemptExecutor | planned | plugin | official open source |
| [Desktop runner](#desktop-runner) | runner | AttemptExecutor | idea | plugin | official commercial |
| [Desktop test machines](#desktop-test-machines) | environment provider | new MachineProvider (ADR before implementation) | idea | plugin | official commercial |
| [gRPC](#grpc) | runner | AttemptExecutor | planned | plugin | official open source |
| [Message brokers](#message-brokers) | runner | AttemptExecutor | planned | plugin | official open source |
| [Contract testing (Pact)](#contract-testing-pact) | runner | AttemptExecutor | planned | plugin | official open source |
| [Security scanner (OWASP ZAP)](#security-scanner-owasp-zap) | runner | AttemptExecutor | planned | plugin | official open source |
| [Performance runners](#performance-runners) | runner | new PerformanceRunner (ADR before implementation) | idea | plugin | official open source |
| [Lighthouse](#lighthouse) | runner | AttemptExecutor | idea | plugin | official open source |
| [Mocks on demand](#mocks-on-demand) | mock server | new MockServer (ADR before implementation) | planned | plugin | official open source |
| [Poor network conditions](#poor-network-conditions) | tool | new NetworkShaper (ADR before implementation) | idea | plugin | official open source |
| [Figma design check](#figma-design-check) | tool | new DesignSource (ADR before implementation) | planned | plugin | official commercial |
| [Existing automated test suites](#existing-automated-test-suites) | test-case source | TestCaseSource | planned | plugin | official open source |
| [Chain adapters](#chain-adapters) | chain | new ChainAdapter (ADR before implementation) | idea | plugin | official commercial |
| [Wallets](#wallets) | wallet | new WalletDriver (ADR before implementation) | idea | plugin | official commercial |
| [Remote environment](#remote-environment) | environment provider | EnvProvider | exists | core | official open source |
| [Docker Compose and managed processes](#docker-compose-and-managed-processes) | environment provider | EnvProvider | exists | plugin | official open source |
| [Preview environments](#preview-environments) | environment provider | EnvProvider | idea | plugin | official open source |
| [LanceDB](#lancedb) | knowledge store | VectorStore | exists | plugin | official open source |
| [Chroma](#chroma) | knowledge store | VectorStore | exists | plugin | official open source |
| [Confluence](#confluence) | document source, publisher | DocumentSource, Publisher | exists | plugin | official open source |
| [Embeddings](#embeddings) | embedder | Embedder | exists | core | official open source |
| [Environment and .env.local](#environment-and-envlocal) | secret provider | SecretProvider | exists | core | official open source |
| [HashiCorp Vault](#hashicorp-vault) | secret provider | SecretProvider | exists | plugin | official open source |
| [Doppler](#doppler) | secret provider | SecretProvider | exists | plugin | official open source |
| [Secret manager CLIs](#secret-manager-clis) | secret provider | SecretProvider | exists | plugin | official open source |
| [webhook.site](#webhooksite) | message capture | MessageCapture | exists | plugin | official open source |
| [SMS capture](#sms-capture) | message capture | MessageCapture | idea | plugin | partner |
| [Local evidence store](#local-evidence-store) | evidence store | EvidenceStore | exists | core | official open source |
| [S3 Object Lock (WORM)](#s3-object-lock-worm) | evidence archive | EvidenceArchive | exists | plugin | official open source |
| [Other immutable storage](#other-immutable-storage) | evidence archive | EvidenceArchive | idea | plugin | official commercial |
| [Slack and Microsoft Teams](#slack-and-microsoft-teams) | publisher | Publisher | idea | plugin | official open source |
| [Model providers](#model-providers) | model provider | ModelProvider | exists | core | official open source |
| [OpenTelemetry export](#opentelemetry-export) | telemetry | new TelemetryExporter (ADR only if a backend needs more than OTLP) | exists | core | official open source |
| [MCP tool servers](#mcp-tool-servers) | tool | new ToolPlugin (ADR before implementation) | exists | plugin | community |
| [CI integrations](#ci-integrations) | pipeline | - | exists | outside | official open source |
| [Claude Code plugin](#claude-code-plugin) | tool | - | exists | outside | official open source |
<!-- plugin-index:end -->
<!-- prettier-ignore-end -->

## How to read an entry

| Field        | Meaning                                                                                                                                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type         | Plugin type(s), from `PLUGIN_TYPES` in the check. REQ-GEN-11/AC7 lists seven types; this page needs more (see [Plugin types and interfaces](#plugin-types-and-interfaces)).                                                                  |
| Interface    | What it implements in `@qajitsu/core`. `new <Name>` is a gap: no interface fits yet, and an ADR comes before implementation (AC3).                                                                                                           |
| Status       | `exists` (code in this repository), `planned` (an accepted or in-progress requirement needs it), `idea` (only proposed or deferred requirements, or a candidate).                                                                            |
| Package      | Where the code lives (or will be extended); `-` when there is none yet.                                                                                                                                                                      |
| Requirements | The requirements that need it.                                                                                                                                                                                                               |
| Dependencies | External npm packages with their installed size, measured on macOS arm64 on 2026-11-01 with every transitive dependency (`zod` is shared with the core, so it adds nothing). Tools `qj setup` downloads are listed with their manifest size. |
| Hosts        | Where it connects. Every host must also be on the environment allowlist (INV-10).                                                                                                                                                            |
| Secrets      | What it needs from the secret provider (INV-8).                                                                                                                                                                                              |
| Tier         | Proposed tier (REQ-GEN-12): official open source, official commercial, partner or community.                                                                                                                                                 |
| Placement    | `core` (ships with every installation), `plugin` (installed on demand, REQ-GEN-11) or `outside` (runs QAJitsu from another tool and is not loaded by it).                                                                                    |
| Names        | Integration names that requirements use for it; the check matches them.                                                                                                                                                                      |

## Ticket systems and test management

### Jira Cloud and Data Center

- Type: ticket source, publisher, ticket workflow, bug tracker, document source
- Interface: TicketSource, Publisher, TicketWorkflow, BugTracker, DocumentSource
- Status: exists
- Package: packages/adapters/ticket-jira, packages/adapters/publish-jira
- Requirements: REQ-CTX-01, REQ-PUB-01, REQ-PUB-03, REQ-PUB-04, REQ-PUB-07, REQ-FLOW-01, REQ-FLOW-02, REQ-FLOW-03, REQ-KNOW-12
- Dependencies: zod (shared)
- Hosts: `<site>.atlassian.net` (Cloud), the project's Jira base URL (Data Center)
- Secrets: API token with the account e-mail (Cloud), personal access token (Data Center)
- Tier: official open source
- Placement: plugin
- Names: Jira, Data Center
- Notes: Comments are ADF on Cloud and wiki markup on Data Center. Linked Jira pages are a document source for the knowledge base. `qj init` installs it for Jira projects, so the usual flow needs no extra step (REQ-GEN-11/AC1).

### Xray

- Type: test-case source, publisher
- Interface: TestCaseSource, new ResultImporter (ADR before implementation)
- Status: exists
- Package: packages/adapters/testcases
- Requirements: REQ-CTX-08, REQ-PUB-05
- Dependencies: zod (shared)
- Hosts: `xray.cloud.getxray.app` (Cloud), the Jira Data Center base URL (Xray Server)
- Secrets: client id and client secret (Cloud), Jira token (Server)
- Tier: official open source
- Placement: plugin
- Names: Xray
- Notes: Reading manual cases exists. Importing results (REQ-PUB-05/AC1, deferred) is not a comment, so it does not fit `Publisher`.

### Zephyr Scale

- Type: test-case source, publisher
- Interface: TestCaseSource, new ResultImporter (ADR before implementation)
- Status: exists
- Package: packages/adapters/testcases
- Requirements: REQ-CTX-08, REQ-PUB-05
- Dependencies: zod (shared)
- Hosts: `api.zephyrscale.smartbear.com` or its EU endpoint
- Secrets: API token
- Tier: official open source
- Placement: plugin
- Names: Zephyr, Zephyr Scale

### Zephyr Squad

- Type: test-case source, publisher
- Interface: TestCaseSource, new ResultImporter (ADR before implementation)
- Status: idea
- Package: packages/adapters/testcases
- Requirements: REQ-GEN-14
- Dependencies: zod (shared)
- Hosts: the Zephyr Squad Cloud API
- Secrets: access key and secret key
- Tier: official open source
- Placement: plugin
- Names: Zephyr Squad

### TestRail

- Type: test-case source, publisher
- Interface: TestCaseSource, new ResultImporter (ADR before implementation)
- Status: exists
- Package: packages/adapters/testcases
- Requirements: REQ-CTX-08, REQ-GEN-11
- Dependencies: zod (shared)
- Hosts: the project's TestRail URL
- Secrets: user name and API key
- Tier: official open source
- Placement: plugin
- Names: TestRail

### qTest

- Type: test-case source, publisher
- Interface: TestCaseSource, new ResultImporter (ADR before implementation)
- Status: idea
- Package: -
- Requirements: REQ-GEN-14
- Dependencies: none expected
- Hosts: `<site>.qtestnet.com`
- Secrets: API token
- Tier: official commercial
- Placement: plugin
- Names: qTest

### Azure DevOps Boards and Test Plans

- Type: ticket source, test-case source, ticket workflow, publisher
- Interface: TicketSource, TestCaseSource, TicketWorkflow, Publisher
- Status: idea
- Package: -
- Requirements: REQ-GEN-14, REQ-CTX-09
- Dependencies: none expected
- Hosts: `dev.azure.com`, the Azure DevOps Server URL
- Secrets: personal access token
- Tier: official open source
- Placement: plugin
- Names: Azure DevOps
- Notes: Work item ids are numbers, which `TicketKey` (`PROJ-123`) does not accept; see the ticket source gap.

### Linear

- Type: ticket source, ticket workflow
- Interface: TicketSource, TicketWorkflow
- Status: idea
- Package: -
- Requirements: REQ-GEN-14, REQ-CTX-09
- Dependencies: none expected
- Hosts: `api.linear.app`
- Secrets: API key
- Tier: official open source
- Placement: plugin
- Names: Linear

### Notion

- Type: ticket source, document source
- Interface: TicketSource, DocumentSource
- Status: idea
- Package: -
- Requirements: REQ-CTX-09
- Dependencies: none expected
- Hosts: `api.notion.com`
- Secrets: integration token
- Tier: official open source
- Placement: plugin
- Names: Notion

### Local files

- Type: ticket source, ticket workflow, publisher, bug tracker, document source, test-case source
- Interface: TicketSource, TicketWorkflow, Publisher, BugTracker, DocumentSource, TestCaseSource
- Status: exists
- Package: packages/adapters/files
- Requirements: REQ-CTX-09, REQ-CTX-01, REQ-CTX-08, REQ-PUB-01, REQ-KNOW-12, REQ-GEN-11
- Dependencies: zod (shared)
- Hosts: none
- Secrets: none
- Tier: official open source
- Placement: core
- Names: -
- Notes: Tickets as `<KEY>.json` files with their workflow, the publisher and bug tracker that write files, resolved bugs for the knowledge base and manual cases from CSV or Excel. The core keeps them, so a project without a ticket system works from ticket to published result without any plugin (REQ-GEN-11/AC1). Moved out of `ticket-jira`, `publish-jira` and `testcases` on 2026-11-03, so those can become plugins. Markdown tickets (REQ-CTX-09/AC2) are still to come.

## Code hosts

### GitHub and GitHub Enterprise Server

- Type: code host
- Interface: CodeHost
- Status: exists
- Package: packages/adapters/codehost-github
- Requirements: REQ-CTX-02, REQ-CTX-03, REQ-PUB-05, REQ-ENV-06, REQ-ENV-13, REQ-CI-08
- Dependencies: zod (shared)
- Hosts: `api.github.com`, `github.com`, the GitHub Enterprise Server host
- Secrets: token (personal or GitHub App)
- Tier: official open source
- Placement: plugin
- Names: GitHub, GitHub Actions
- Notes: Also downloads app builds from GitHub Actions artifacts and reads deployments for readiness.

### GitLab

- Type: code host
- Interface: CodeHost
- Status: exists
- Package: packages/adapters/codehost-gitlab
- Requirements: REQ-CTX-02, REQ-CTX-03, REQ-PUB-05, REQ-ENV-06, REQ-ENV-13, REQ-CI-08
- Dependencies: zod (shared)
- Hosts: `gitlab.com`, the self-managed GitLab host
- Secrets: token (personal, project or group)
- Tier: official open source
- Placement: plugin
- Names: GitLab, GitLab CI

### Local git repositories

- Type: code host
- Interface: CodeHost
- Status: exists
- Package: packages/adapters/codehost-local
- Requirements: REQ-NFR-04, REQ-CTX-03
- Dependencies: none (git from the system)
- Hosts: none
- Secrets: none
- Tier: official open source
- Placement: core
- Names: -

### Bitbucket Cloud and Data Center

- Type: code host
- Interface: CodeHost
- Status: idea
- Package: -
- Requirements: REQ-GEN-14
- Dependencies: none expected
- Hosts: `api.bitbucket.org`, the Bitbucket Data Center URL
- Secrets: access token or app password
- Tier: official open source
- Placement: plugin
- Names: Bitbucket

### Azure Repos

- Type: code host
- Interface: CodeHost
- Status: idea
- Package: -
- Requirements: REQ-GEN-14
- Dependencies: none expected
- Hosts: `dev.azure.com`
- Secrets: personal access token
- Tier: official open source
- Placement: plugin
- Names: Azure Repos

## Runners

### API runner

- Type: runner, test data
- Interface: AttemptExecutor, TestDataProvider
- Status: exists
- Package: packages/adapters/runner-api
- Requirements: REQ-EXEC-04, REQ-EXEC-45, REQ-EXEC-46, REQ-EXEC-53, REQ-EVD-01
- Dependencies: playwright-core, ajv, yaml, pngjs: 22 MB (playwright-core, 13.5 MB of it, is shared with the web runner)
- Hosts: the environment and its allowlist only
- Secrets: account credentials by alias
- Tier: official open source
- Placement: plugin
- Names: -
- Notes: GraphQL (REQ-EXEC-48), SOAP (REQ-EXEC-50) and WebSocket and server-sent events (REQ-EXEC-47) extend this runner.

### Web runner

- Type: runner
- Interface: AttemptExecutor
- Status: exists
- Package: packages/adapters/runner-web
- Requirements: REQ-EXEC-05, REQ-EXEC-61, REQ-EXEC-66, REQ-EXEC-67, REQ-EVD-02
- Dependencies: playwright-core, axe-core, pixelmatch, pngjs: 17 MB; browsers through `qj setup` (340 MB)
- Hosts: the environment and its allowlist only
- Secrets: account credentials and TOTP seeds by alias
- Tier: official open source
- Placement: plugin
- Names: Playwright, axe-core

### Mobile runner (Appium)

- Type: runner
- Interface: AttemptExecutor
- Status: exists
- Package: packages/adapters/runner-mobile
- Requirements: REQ-EXEC-06, REQ-ENV-06, REQ-EXEC-43, REQ-EXEC-44
- Dependencies: webdriverio: 51 MB (217 packages); Appium (60 MB), UiAutomator2 (40 MB), Java (190 MB), the Android SDK and emulator through `qj setup`
- Hosts: the local Appium server, a device farm hub, the environment
- Secrets: account credentials by alias; device farm user and key
- Tier: official open source
- Placement: plugin
- Names: Appium, WebdriverIO, Firebase
- Notes: Push notifications use Firebase test tokens (REQ-EXEC-43/AC3).

### Device farms

- Type: device provider
- Interface: new DeviceProvider (ADR before implementation)
- Status: exists
- Package: packages/adapters/runner-mobile
- Requirements: REQ-ENV-06, REQ-EXEC-35, REQ-SCALE-08
- Dependencies: none beyond the mobile or web runner
- Hosts: `hub.browserstack.com`, `ondemand.<region>.saucelabs.com`, `hub.lambdatest.com`, AWS Device Farm and Firebase Test Lab endpoints
- Secrets: user name and access key
- Tier: partner
- Placement: plugin
- Names: BrowserStack, Sauce Labs, LambdaTest, AWS Device Farm, Firebase Test Lab
- Notes: Today a farm is a WebDriver URL given to the mobile runner. Farm sessions, app upload and the farm's own video are not behind an interface.

### Maestro

- Type: runner
- Interface: AttemptExecutor
- Status: planned
- Package: -
- Requirements: REQ-EXEC-52, REQ-PLAN-17, REQ-PLAN-18, REQ-GEN-13
- Dependencies: the Maestro CLI and Java through `qj setup` (size measured when implemented)
- Hosts: the environment, the device or emulator
- Secrets: account credentials by alias
- Tier: official open source
- Placement: plugin
- Names: Maestro

### Desktop runner

- Type: runner
- Interface: AttemptExecutor
- Status: idea
- Package: -
- Requirements: REQ-EXEC-37
- Dependencies: Appium Windows and Mac2 drivers or FlaUI, AT-SPI on Linux, Playwright for Electron (sizes measured when implemented)
- Hosts: the desktop test machine
- Secrets: account credentials by alias
- Tier: official commercial
- Placement: plugin
- Names: Electron, Tauri, FlaUI

### Desktop test machines

- Type: environment provider
- Interface: new MachineProvider (ADR before implementation)
- Status: idea
- Package: -
- Requirements: REQ-ENV-12
- Dependencies: the hypervisor's or cloud's CLI or API
- Hosts: the machine pool, the snapshot API
- Secrets: machine and cloud credentials
- Tier: official commercial
- Placement: plugin
- Names: -

### gRPC

- Type: runner
- Interface: AttemptExecutor
- Status: planned
- Package: -
- Requirements: REQ-EXEC-49
- Dependencies: @grpc/grpc-js and protobufjs (size measured when implemented)
- Hosts: the environment and its allowlist only
- Secrets: account credentials by alias
- Tier: official open source
- Placement: plugin
- Names: -

### Message brokers

- Type: runner
- Interface: AttemptExecutor
- Status: planned
- Package: -
- Requirements: REQ-EXEC-51
- Dependencies: one client per broker: kafkajs, amqplib, mqtt (sizes measured when implemented)
- Hosts: the brokers of the environment
- Secrets: broker credentials
- Tier: official open source
- Placement: plugin
- Names: Kafka, RabbitMQ, MQTT

### Contract testing (Pact)

- Type: runner
- Interface: AttemptExecutor
- Status: planned
- Package: -
- Requirements: REQ-EXEC-59, REQ-EXEC-35
- Dependencies: @pact-foundation/pact with its native core (size measured when implemented)
- Hosts: the Pact Broker, the environment
- Secrets: broker token
- Tier: official open source
- Placement: plugin
- Names: Pact

### Security scanner (OWASP ZAP)

- Type: runner
- Interface: AttemptExecutor
- Status: planned
- Package: -
- Requirements: REQ-EXEC-57
- Dependencies: the ZAP container image through Docker (size measured when implemented)
- Hosts: the allowlisted test environment only
- Secrets: account credentials by alias
- Tier: official open source
- Placement: plugin
- Names: ZAP

### Performance runners

- Type: runner
- Interface: new PerformanceRunner (ADR before implementation)
- Status: idea
- Package: -
- Requirements: REQ-PERF-01, REQ-PERF-02, REQ-PERF-03, REQ-EXEC-35
- Dependencies: one tool per plugin: k6, Gatling, JMeter, Locust, through `qj setup` (sizes measured when implemented)
- Hosts: the environment, and load generators when remote
- Secrets: account credentials by alias
- Tier: official open source
- Placement: plugin
- Names: k6, Gatling, JMeter, Locust

### Lighthouse

- Type: runner
- Interface: AttemptExecutor
- Status: idea
- Package: -
- Requirements: REQ-EXEC-35
- Dependencies: lighthouse (size measured when implemented), browsers of the web runner
- Hosts: the environment and its allowlist only
- Secrets: none
- Tier: official open source
- Placement: plugin
- Names: Lighthouse

### Mocks on demand

- Type: mock server
- Interface: new MockServer (ADR before implementation)
- Status: planned
- Package: -
- Requirements: REQ-EXEC-60, REQ-ENV-05
- Dependencies: WireMock (Java) or Mockoon or Prism, as containers or through `qj setup`
- Hosts: the run's own mock servers
- Secrets: none
- Tier: official open source
- Placement: plugin
- Names: WireMock, Wiremock, Mockoon, Prism
- Notes: Fixed stubs per environment exist in the compose environment (REQ-ENV-05); mocks per case do not.

### Poor network conditions

- Type: tool
- Interface: new NetworkShaper (ADR before implementation)
- Status: idea
- Package: -
- Requirements: REQ-EXEC-26
- Dependencies: Toxiproxy (container), or browser throttling of the web runner
- Hosts: the run's own environment only
- Secrets: none
- Tier: official open source
- Placement: plugin
- Names: Toxiproxy

### Figma design check

- Type: tool
- Interface: new DesignSource (ADR before implementation)
- Status: planned
- Package: -
- Requirements: REQ-EXEC-18
- Dependencies: none expected
- Hosts: `api.figma.com`
- Secrets: Figma token
- Tier: official commercial
- Placement: plugin
- Names: Figma

### Existing automated test suites

- Type: test-case source
- Interface: TestCaseSource
- Status: planned
- Package: -
- Requirements: REQ-PLAN-18
- Dependencies: none expected (files of the test repository)
- Hosts: none
- Secrets: none
- Tier: official open source
- Placement: plugin
- Names: Selenium, Cypress, Postman
- Notes: Maps existing Playwright, Appium, Maestro, Selenium, Cypress and Postman tests to cases and requirements.

## Blockchain

### Chain adapters

- Type: chain
- Interface: new ChainAdapter (ADR before implementation)
- Status: idea
- Package: -
- Requirements: REQ-CHAIN-01, REQ-CHAIN-02, REQ-CHAIN-03, REQ-CHAIN-04, REQ-CHAIN-05, REQ-CHAIN-08, REQ-CHAIN-09
- Dependencies: one SDK per chain family (viem, @solana/web3.js and others), local nodes (Anvil, Hardhat) through `qj setup` (sizes measured when implemented)
- Hosts: allowlisted RPC endpoints, local nodes and forks
- Secrets: test keys and seeds
- Tier: official commercial
- Placement: plugin
- Names: Ethereum, Solana, Hardhat, Foundry, Anvil

### Wallets

- Type: wallet
- Interface: new WalletDriver (ADR before implementation)
- Status: idea
- Package: -
- Requirements: REQ-CHAIN-06, REQ-CHAIN-07
- Dependencies: wallet extensions at pinned versions (sizes measured when implemented)
- Hosts: allowlisted RPC endpoints, the WalletConnect relay
- Secrets: test seeds and keys
- Tier: official commercial
- Placement: plugin
- Names: MetaMask, Rabby, Phantom, Keplr, WalletConnect

## Environment providers

### Remote environment

- Type: environment provider
- Interface: EnvProvider
- Status: exists
- Package: packages/adapters/env-remote
- Requirements: REQ-ENV-01, REQ-ENV-02, REQ-ENV-07, REQ-ENV-13, REQ-EXEC-55
- Dependencies: zod (shared)
- Hosts: the environment's URL and its allowlist
- Secrets: account credentials and TOTP seeds by alias
- Tier: official open source
- Placement: core
- Names: -
- Notes: The core keeps it: every run without `--build` needs it, and readiness logs accounts in through it.

### Docker Compose and managed processes

- Type: environment provider
- Interface: EnvProvider
- Status: exists
- Package: packages/adapters/env-compose
- Requirements: REQ-ENV-03, REQ-ENV-04, REQ-ENV-05, REQ-WS-02
- Dependencies: yaml: 0.7 MB; Docker through `qj setup` (450 MB)
- Hosts: local only (dynamic ports)
- Secrets: service variables from the secret provider
- Tier: official open source
- Placement: plugin
- Names: Docker

### Preview environments

- Type: environment provider
- Interface: EnvProvider
- Status: idea
- Package: -
- Requirements: REQ-ENV-10, REQ-SCALE-09
- Dependencies: none expected (HTTP APIs); `kubectl` or Helm for Kubernetes
- Hosts: `api.vercel.com`, `api.netlify.com`, the Kubernetes API, Argo CD
- Secrets: platform tokens, kubeconfig
- Tier: official open source
- Placement: plugin
- Names: Vercel, Netlify, Kubernetes, Helm, Argo CD
- Notes: Resolves and checks the environment of a change, never deploys it (REQ-ENV-10/AC2). "Vercel" also appears in REQ-LLM-01 as the AI SDK, which is a dependency of the models layer, not an integration.

## Knowledge stores and sources

### LanceDB

- Type: knowledge store
- Interface: VectorStore
- Status: exists
- Package: packages/adapters/knowledge-lancedb
- Requirements: REQ-KNOW-01, REQ-KNOW-08, REQ-CTX-20
- Dependencies: @lancedb/lancedb, apache-arrow: 251 MB (30 packages, with the native binary for the platform)
- Hosts: none (embedded)
- Secrets: none
- Tier: official open source
- Placement: plugin
- Names: LanceDB
- Notes: The largest integration by far, and the first one out of the CLI (2026-11-03): `qj plugin add knowledge-lancedb`. It omits LanceDB's optional embedding helpers (`omit_optional`), because QAJitsu embeds through the models layer.

### Chroma

- Type: knowledge store
- Interface: VectorStore
- Status: exists
- Package: packages/adapters/knowledge-chroma
- Requirements: REQ-KNOW-08
- Dependencies: zod (shared)
- Hosts: the shared Chroma server
- Secrets: Chroma token (optional)
- Tier: official open source
- Placement: plugin
- Names: Chroma

### Confluence

- Type: document source, publisher
- Interface: DocumentSource, Publisher
- Status: exists
- Package: packages/adapters/knowledge-confluence
- Requirements: REQ-KNOW-12, REQ-CTX-09, REQ-OBS-13
- Dependencies: zod (shared)
- Hosts: `<site>.atlassian.net/wiki`, the Confluence Data Center URL
- Secrets: API token with the account e-mail, or personal access token
- Tier: official open source
- Placement: plugin
- Names: Confluence
- Notes: Reading spaces and pages exists. Tickets from pages (REQ-CTX-09) and posting reports (REQ-OBS-13/AC2) are ideas.

### Embeddings

- Type: embedder
- Interface: Embedder
- Status: exists
- Package: packages/models
- Requirements: REQ-KNOW-08, REQ-CTX-20
- Dependencies: those of the models layer
- Hosts: the configured model provider (local Ollama by default)
- Secrets: the provider's API key, when remote
- Tier: official open source
- Placement: core
- Names: -

## Secret managers

### Environment and .env.local

- Type: secret provider
- Interface: SecretProvider
- Status: exists
- Package: packages/adapters/secrets-env
- Requirements: REQ-CFG-03
- Dependencies: none
- Hosts: none
- Secrets: none (it is the source)
- Tier: official open source
- Placement: core
- Names: -

### HashiCorp Vault

- Type: secret provider
- Interface: SecretProvider
- Status: exists
- Package: packages/adapters/secrets-vault
- Requirements: REQ-CFG-03
- Dependencies: none
- Hosts: the Vault URL
- Secrets: Vault token (from the environment)
- Tier: official open source
- Placement: plugin
- Names: Vault

### Doppler

- Type: secret provider
- Interface: SecretProvider
- Status: exists
- Package: packages/adapters/secrets-doppler
- Requirements: REQ-CFG-03
- Dependencies: none
- Hosts: `api.doppler.com`
- Secrets: Doppler service token (from the environment)
- Tier: official open source
- Placement: plugin
- Names: Doppler

### Secret manager CLIs

- Type: secret provider
- Interface: SecretProvider
- Status: exists
- Package: packages/adapters/secrets-cli
- Requirements: REQ-CFG-03
- Dependencies: none in npm; the vendor's CLI (`op`, `aws`, `gcloud`) installed by the user
- Hosts: those the vendor CLI uses
- Secrets: the CLI's own sign-in
- Tier: official open source
- Placement: plugin
- Names: 1Password, AWS Secrets Manager, GCP Secret Manager

## Message capture

### webhook.site

- Type: message capture
- Interface: MessageCapture
- Status: exists
- Package: packages/adapters/messages-webhooksite
- Requirements: REQ-ENV-08
- Dependencies: zod (shared)
- Hosts: `webhook.site` or the self-hosted instance
- Secrets: API key
- Tier: official open source
- Placement: plugin
- Names: webhook.site

### SMS capture

- Type: message capture
- Interface: MessageCapture
- Status: idea
- Package: -
- Requirements: REQ-ENV-08
- Dependencies: none expected
- Hosts: the SMS provider's API
- Secrets: API key
- Tier: partner
- Placement: plugin
- Names: -
- Notes: `CapturedMessage.kind` has no `sms` yet; see the message capture gap.

## Evidence storage

### Local evidence store

- Type: evidence store
- Interface: EvidenceStore
- Status: exists
- Package: packages/adapters/evidence-local
- Requirements: REQ-VER-05, REQ-EVD-01
- Dependencies: zod (shared)
- Hosts: none
- Secrets: none
- Tier: official open source
- Placement: core
- Names: -

### S3 Object Lock (WORM)

- Type: evidence archive
- Interface: EvidenceArchive
- Status: exists
- Package: packages/adapters/evidence-s3
- Requirements: REQ-VER-19, REQ-PUB-02
- Dependencies: none (own SigV4 signing)
- Hosts: the S3 endpoint (AWS, MinIO or another S3-compatible store)
- Secrets: access key id and secret access key
- Tier: official open source
- Placement: plugin
- Names: S3, MinIO, Object Lock

### Other immutable storage

- Type: evidence archive
- Interface: EvidenceArchive
- Status: idea
- Package: -
- Requirements: REQ-VER-19
- Dependencies: none expected
- Hosts: Azure Blob Storage, Google Cloud Storage
- Secrets: storage credentials
- Tier: official commercial
- Placement: plugin
- Names: -
- Notes: Azure immutable blobs and Google Cloud Storage bucket lock map to the same retention modes.

## Publishers and notifications

### Slack and Microsoft Teams

- Type: publisher
- Interface: Publisher
- Status: idea
- Package: -
- Requirements: REQ-OBS-13
- Dependencies: none expected
- Hosts: `hooks.slack.com`, the Teams webhook host
- Secrets: webhook URL or bot token
- Tier: official open source
- Placement: plugin
- Names: Slack, Microsoft Teams
- Notes: `PublishInput.comment` is Jira-shaped (ADF and wiki); see the publisher gap.

## Models

### Model providers

- Type: model provider
- Interface: ModelProvider
- Status: exists
- Package: packages/models
- Requirements: REQ-LLM-01, REQ-LLM-09, REQ-LLM-10, REQ-LLM-15
- Dependencies: ai, @ai-sdk/anthropic, @ai-sdk/openai, @ai-sdk/google, @ai-sdk/openai-compatible, ai-sdk-ollama: 38 MB (19 packages)
- Hosts: `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, local Ollama, the configured gateway
- Secrets: provider API keys
- Tier: official open source
- Placement: core
- Names: Anthropic, OpenAI, Gemini, Ollama, LiteLLM, OpenRouter, Bedrock, vLLM, LM Studio
- Notes: Stays in the core for now: every agent needs a model, and INV-11 already keeps provider SDKs in this one package. Splitting it per provider is a later decision.

## Observability

### OpenTelemetry export

- Type: telemetry
- Interface: new TelemetryExporter (ADR only if a backend needs more than OTLP)
- Status: exists
- Package: packages/core
- Requirements: REQ-OBS-03, REQ-OBS-04, REQ-OBS-13, REQ-LLM-14
- Dependencies: none (OTLP over HTTP)
- Hosts: the configured OTLP collector
- Secrets: collector headers, when needed
- Tier: official open source
- Placement: core
- Names: OpenTelemetry, Prometheus, Grafana, Datadog, Langfuse
- Notes: Grafana, Datadog and Langfuse receive OTLP; they are backends, not plugins.

## Tools and pipelines

### MCP tool servers

- Type: tool
- Interface: new ToolPlugin (ADR before implementation)
- Status: exists
- Package: packages/agents
- Requirements: REQ-EXEC-01, REQ-VER-03, REQ-NFR-13
- Dependencies: @ai-sdk/mcp (part of the agents package)
- Hosts: per server, through the guard
- Secrets: per server, through the secret provider
- Tier: community
- Placement: plugin
- Names: -
- Notes: REQ-GEN-11/AC7 names "tool" as a plugin type, but the core has no interface for it: today agents reach MCP servers through the guard.

### CI integrations

- Type: pipeline
- Interface: -
- Status: exists
- Package: ci/github, ci/gitlab, ci/jenkins, ci/docker
- Requirements: REQ-CI-01, REQ-CI-03, REQ-CI-06, REQ-CI-08
- Dependencies: the QAJitsu Docker image for other CI systems
- Hosts: the CI system's own
- Secrets: CI variables mapped to the secret provider
- Tier: official open source
- Placement: outside
- Names: Jenkins
- Notes: The GitHub Action, the GitLab CI template, the Jenkinsfile and the Docker image run QAJitsu; QAJitsu does not load them.

### Claude Code plugin

- Type: tool
- Interface: -
- Status: exists
- Package: plugin
- Requirements: REQ-GEN-04, REQ-GEN-07
- Dependencies: none
- Hosts: none
- Secrets: none
- Tier: official open source
- Placement: outside
- Names: -

## Plugin types and interfaces

REQ-GEN-14/AC3: for each plugin type, the interface it implements and where that interface does not fit a listed
plugin. A gap is changed in an ADR before the plugin that needs it is implemented.

| Plugin type          | Interface                                     | Fits                                                | Gaps                                                                                                                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ticket source        | `TicketSource`                                | Jira, Linear, Notion, ticket files                  | `TicketKey` accepts only `PROJ-123`; Azure DevOps work items (`1234`) and GitHub issues (`#12`) need a wider key. **ADR before Azure DevOps.**                                                                                                                                                               |
| ticket workflow      | `TicketWorkflow`                              | Jira                                                | `findInStatus` takes JQL, `inGroup` assumes Jira groups, transitions are Jira's. Linear and Azure DevOps move states directly. **ADR before Linear or Azure DevOps.**                                                                                                                                        |
| bug tracker          | `BugTracker`                                  | Jira                                                | `BugDraft.description` carries ADF and wiki; other trackers need Markdown. Small change: add `markdown`.                                                                                                                                                                                                     |
| test-case source     | `TestCaseSource`                              | Xray, Zephyr Scale and Squad, TestRail, qTest       | `ImportedCase.system` is a closed list, so a plugin cannot add a system. Existing automated suites (REQ-PLAN-18) map code, not manual cases. **ADR before qTest or REQ-PLAN-18.**                                                                                                                            |
| publisher            | `Publisher`                                   | Jira, Confluence                                    | The input is a Jira comment (`adf`, `wiki`). Result imports into Xray, Zephyr, TestRail and qTest need structured results per case (new `ResultImporter`). Slack and Teams need Markdown. **ADR before REQ-PUB-05/AC1 or REQ-OBS-13/AC4.**                                                                   |
| code host            | `CodeHost`                                    | GitHub, GitLab, local, Bitbucket, Azure Repos       | None found. Build artifacts (`downloadArtifact`) are tied to the code host; Bitbucket Pipelines and Azure Pipelines fit.                                                                                                                                                                                     |
| runner               | `AttemptExecutor`                             | API, web, mobile, Maestro, gRPC, brokers, Pact, ZAP | Runners are chosen by fixed lanes (`api`, `web`, `mobile`), and a plugin cannot declare which case types it runs. Tools with their own verdict (k6, ZAP, Pact, Lighthouse) need their report mapped to assertions by code (REQ-EXEC-35/AC3, INV-1). **ADR before the first runner outside the three lanes.** |
| performance runner   | none (`new PerformanceRunner`)                | k6, Gatling, JMeter, Locust                         | Load profiles and raw metrics (REQ-PERF-01..03) are not attempts. **ADR before REQ-PERF-02.**                                                                                                                                                                                                                |
| environment provider | `EnvProvider`                                 | remote, compose, preview platforms                  | Preview platforms only resolve (no start or stop); `start()` and `stop()` must allow that. Desktop machines need snapshots (new `MachineProvider`). **ADR before REQ-ENV-10 or REQ-ENV-12.**                                                                                                                 |
| device provider      | none (`new DeviceProvider`)                   | Android emulator, device farms                      | Devices are part of the mobile runner. Farm sessions, app upload and farm video have no interface. **ADR before a second farm or the iOS simulator (REQ-EXEC-44).**                                                                                                                                          |
| secret provider      | `SecretProvider`                              | env, Vault, Doppler, CLIs                           | None found.                                                                                                                                                                                                                                                                                                  |
| evidence store       | `EvidenceStore`                               | local                                               | None found.                                                                                                                                                                                                                                                                                                  |
| evidence archive     | `EvidenceArchive`                             | S3 Object Lock, Azure and Google storage            | None found; the retention modes map to all three.                                                                                                                                                                                                                                                            |
| knowledge store      | `VectorStore`                                 | LanceDB, Chroma                                     | None found.                                                                                                                                                                                                                                                                                                  |
| document source      | `DocumentSource`                              | Confluence, Jira, Notion                            | None found.                                                                                                                                                                                                                                                                                                  |
| embedder             | `Embedder`                                    | models layer                                        | None found.                                                                                                                                                                                                                                                                                                  |
| message capture      | `MessageCapture`                              | webhook.site                                        | `CapturedMessage.kind` is `email` or `http`; SMS needs `sms`. Small change.                                                                                                                                                                                                                                  |
| test data            | `TestDataProvider`                            | API requests, data hook                             | None found.                                                                                                                                                                                                                                                                                                  |
| mock server          | none (`new MockServer`)                       | WireMock, Mockoon, Prism                            | Needs an interface for setting up, counting and removing mocks per case (REQ-EXEC-60). **ADR before REQ-EXEC-60.**                                                                                                                                                                                           |
| model provider       | `ModelProvider`                               | every provider of the models layer                  | None found; stays in the core.                                                                                                                                                                                                                                                                               |
| tool                 | none (`new ToolPlugin`)                       | MCP servers, network shaping, Figma                 | REQ-GEN-11/AC7 lists the type, but there is no interface. **ADR before the first tool plugin.**                                                                                                                                                                                                              |
| chain, wallet        | none (`new ChainAdapter`, `new WalletDriver`) | chain families, browser wallets                     | Defined by REQ-CHAIN-01 and REQ-CHAIN-06. **ADR before any chain work.**                                                                                                                                                                                                                                     |
| telemetry, pipeline  | none needed                                   | OTLP backends, CI systems                           | Not plugins: OTLP covers the backends; CI integrations run QAJitsu from outside.                                                                                                                                                                                                                             |

Every plugin declares its types in its manifest (REQ-GEN-11/AC7), which lists the plugin types of this table.
Model providers, embedders, telemetry and pipelines are not plugin types: the first two stay in the core, the last two
are not loaded by QAJitsu. A new plugin type is added to REQ-GEN-11/AC7, `PLUGIN_TYPES` in the check and this table
in the same change, with its ADR.

## How plugins are installed and loaded

REQ-GEN-11, implemented in `packages/cli/src/plugins/`. **Manifest.** Each plugin's `package.json` has
`qajitsu.plugin`: its types (those of this page), the range of the core's adapter API it works with (`core_api`,
checked against `PLUGIN_API_VERSION` of `@qajitsu/core`), the secrets, hosts (`config` for the URL the project
configures) and permissions (`network`, `exec`, `filesystem`) it needs. The manifest can also list `omit_optional`:
optional dependencies the plugin never loads. They are installed as empty packages, the same way the workspace
ignores them for pnpm (`ignoredOptionalDependencies`). The manifest is read from the tarball before npm runs. A contract test checks every adapter
package's manifest against this inventory.

**Catalogue.** `packages/cli/plugins.json` pins the version of every official plugin for a release. It is written by
`pnpm plugins:catalogue` after `changeset version`, and a test fails while it is stale.

**Install.** The registry version's tarball is checked against its published sha512, and it must come from the
registry's own host. npm then installs it into `~/.qajitsu/plugins/<id>/<version>/` with `--ignore-scripts`. The
manifest and API range are checked before an installed version is replaced, and `installed.json` and `history.jsonl`
record what happened.

**Load.** A plugin still carried by the installation is imported as it is. An installed one is imported from its
folder, and QAJitsu's own packages are linked into `~/.qajitsu/plugins/node_modules/` while the plugin's own copies
are deleted, so every plugin runs against the installation's core, steps, guard and verifier. A missing plugin stops
the command with `qj plugin add <id>`.

**Guard (ADR-0015).**

- At install, and again when an installed plugin is loaded, its own code is checked against its permissions. Node's
  network, process and file modules, reads of `process.env` and the global `fetch` must be declared, and no plugin may
  refer to `plan.approved.yaml`. A plugin that does more is refused.
- Every HTTP call of an integration plugin goes through a guarded `fetch`: only to the hosts of its manifest and the
  URLs the project configures for it.
- A contract test runs the same code check over every adapter in this repository.

**What a plugin package needs.** It depends on QAJitsu's own packages as `peerDependencies`, never as
`dependencies`, so npm does not fetch a second copy. Each plugin pull request (REQ-GEN-11/AC11) moves its package to
peer dependencies, removes it from `@qajitsu/cli`'s dependencies and loads it through the plugin loader. A plugin that needs another plugin lists it as a peer dependency too, and `qj plugin add` installs both.
Third-party versions coupled to tools that `qj setup` installs are pinned exactly. For example, `playwright-core` is
`1.63.0` in the CLI and in every runner, because the browsers are installed for one Playwright version. An installed
web runner that resolved a newer version found no browser. A contract test checks this.

## Core and plugins

REQ-GEN-14/AC4. **Accepted on 2026-11-01** (ADR-0011).

**The core keeps** what every installation needs to go from a ticket to a published result without any plugin, plus
what decides results:

- the guard, the verifier, status computation, masking, publish gates and the steps library (never plugins, INV-1,
  INV-8, REQ-GEN-11/AC4);
- ticket files, local git repositories (`codehost-local`), secrets from the environment (`secrets-env`) and the
  local evidence store (`evidence-local`), as REQ-GEN-11/AC1 lists;
- the remote environment (`env-remote`), because every run without `--build` uses it and readiness logs accounts in
  through it;
- the models layer (`packages/models`), because every agent needs a model and INV-11 already isolates provider SDKs;
- OpenTelemetry export.

**Everything else becomes a plugin**, still developed and released from this repository. `qj init` installs the
official plugins the chosen setup needs, so the usual Jira and GitHub flow needs no extra step.

Jira, GitHub, GitLab and the API and web runners are plugins too, like REQ-GEN-11/AC1 says; ADR-0011 records it.
Every plugin is easy to add and to install on demand: it implements the core interfaces and nothing else.

**Migration order.** Each wave starts only after the previous one runs from installed plugins in CI.

1. **Knowledge** (`knowledge-lancedb`, `knowledge-chroma`, `knowledge-confluence`). LanceDB alone is 251 MB, and
   most projects do not use it. **`knowledge-lancedb` moved out on 2026-11-03:** the published CLI went from 389 MB
   (312 packages) to 141 MB (290). The installed plugin is 245 MB, because LanceDB's own embedding helpers
   (`@huggingface/transformers` with onnxruntime, `openai`, 362 MB more) are omitted. Knowledge is optional, so a mistake cannot affect a result. This wave proves loading,
   `qj doctor` messages and offline bundles.
2. **Optional services** (`secrets-vault`, `secrets-doppler`, `secrets-cli`, `messages-webhooksite`, `evidence-s3`,
   `testcases`). These packages are small and have simple interfaces, and only some projects use them.
3. **Runners and environments** (`runner-mobile` first, at 51 MB and 217 packages, then `runner-web`, `runner-api`
   and `env-compose`). They touch statuses and evidence, so their adversarial suites must run against the installed
   plugin (ADR-0011).
4. **The default flow** (`ticket-jira`, `publish-jira`, `codehost-github`, `codehost-gitlab`). These go last, once
   `qj init` installs plugins reliably, so the most common setup never regresses.

**One plugin per pull request** (REQ-GEN-11/AC11). Each move out of the core, and each new plugin, is its own pull
request with its contract tests against the installed plugin, its adversarial suite where it touches statuses,
evidence or secrets, and its entry here updated. A wave is a sequence of such pull requests, not one large change.

**Moved out so far.** `@qajitsu/cli` size is measured with every transitive dependency; each row is its own pull
request, and its contract runs against the installed copy (`tests/e2e/plugins-installed.e2e.test.ts`).

<!-- moved-out:start -->

| Plugin              | Moved out  | CLI after            |
| ------------------- | ---------- | -------------------- |
| `knowledge-lancedb` | 2026-11-03 | 141 MB (from 389 MB) |
| `knowledge-chroma`  | 2026-11-03 | 141 MB               |

| `knowledge-confluence` | 2026-11-03 | 141.0 MB |
| `secrets-vault` | 2026-11-03 | 141.0 MB |
| `secrets-doppler` | 2026-11-03 | 141.0 MB |
| `secrets-cli` | 2026-11-03 | 140.9 MB |
| `messages-webhooksite` | 2026-11-03 | 140.9 MB |
| `evidence-s3` | 2026-11-03 | 140.9 MB |
| `testcases` | 2026-11-03 | 140.8 MB |
| `ticket-jira` | 2026-11-03 | 140.7 MB |
| `codehost-github` | 2026-11-03 | 140.6 MB |
| `codehost-gitlab` | 2026-11-03 | 140.5 MB |
| `publish-jira` | 2026-11-03 | 140.4 MB |
| `env-compose` | 2026-11-03 | 140.3 MB |
| `runner-api` | 2026-11-03 | 140.3 MB |
| `runner-web` | 2026-11-03 | 136.9 MB |
| `runner-mobile` | 2026-11-03 | 85.8 MB |
<!-- moved-out:end -->

New integrations (Bitbucket, Azure DevOps, Maestro and the rest) start as plugins once their wave's mechanism exists.
Until then they are built as packages under `packages/adapters/`, and the check above keeps them listed here.
