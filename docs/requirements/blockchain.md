# Blockchain testing (CHAIN)

Testing applications built on blockchains, the wallets people use with them, and the chains themselves. Every chain
family gets its own adapter behind one interface, installed as a plugin (REQ-GEN-11). Signing keys stay in the secret
provider and the trusted runner; agents plan and write tests, they never hold a key or sign.

Open for planning (2026-10-23): which chain families come first, which wallets, and the toolchain per chain need an
analysis and an ADR before implementation (REQ-CHAIN-12). Replaces REQ-EXEC-36.

### REQ-CHAIN-01 · Chain adapters behind one interface

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-GEN-02, REQ-GEN-11, REQ-CHAIN-12, INV-12

**Acceptance criteria**

- [ ] AC1: A chain adapter interface covers what tests need from any chain: connect to a node, accounts by alias, send a transaction and wait for its inclusion and finality, read state, read and decode events, and the chain's current block and time.
- [ ] AC2: Adapters exist per chain family as plugins: EVM chains (Ethereum and L2s such as Arbitrum, Optimism, Base, Polygon), Solana, Cosmos SDK, Substrate/Polkadot, Bitcoin, Move chains (Aptos, Sui), TON and Starknet; a project installs only the adapters it uses.
- [ ] AC3: An adapter declares its capabilities (forks, time control, snapshots, tracing); a case that needs a missing capability is BLOCKED with the reason before it runs.
- [ ] AC4: Core and the agents depend only on the interface; no package outside the adapter imports a chain SDK.

### REQ-CHAIN-02 · Local networks, forks and deterministic state

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-CHAIN-01, REQ-ENV-03, REQ-EXEC-53

**Acceptance criteria**

- [ ] AC1: QAJitsu starts and stops a local network per run with the chain's own tools (Anvil or Hardhat, `solana-test-validator`, a local Cosmos or Substrate node, `bitcoind -regtest`, Aptos/Sui localnet), at pinned versions.
- [ ] AC2: A network can fork a public network at a pinned block, so tests see real contracts and balances reproducibly; the block is recorded in the run.
- [ ] AC3: Steps can move time and mine blocks where the chain allows it, and each case can start from a snapshot of the state and revert it afterwards.
- [ ] AC4: Test accounts are created and funded by code from the plan's data (balances, tokens, NFTs, approvals) and named by alias.

### REQ-CHAIN-03 · Network safety

- Status: proposed
- Priority: must
- Stage: later
- Related: REQ-CHAIN-01, REQ-CFG-06, INV-8, INV-10

**Acceptance criteria**

- [ ] AC1: Only local networks and test networks listed in the environment's chain allowlist (by chain id or genesis hash) are reachable; a transaction to any other network, mainnet in particular, is denied by the guard and the case BLOCKED.
- [ ] AC2: Keys and seed phrases of test accounts come from the secret provider, are used only by the trusted runner and wallet driver, and never reach an agent, a log, evidence or Jira unmasked.
- [ ] AC3: On test networks, spending per run is capped (native token and gas); reaching the cap makes the remaining cases NOT_RUN with the reason.
- [ ] AC4: The planner and the author can read public chain data for grounding; they can never send transactions.

### REQ-CHAIN-04 · Smart contract and program testing

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-CHAIN-01, REQ-PLAN-03, REQ-EXEC-02, INV-1, INV-4

**Acceptance criteria**

- [ ] AC1: The analyst reads contract and program sources, ABIs and IDLs from the change, and the planner cites the functions, events and errors a case covers; citations are checked by code.
- [ ] AC2: Steps call read functions and send transactions as a test account; expectations from the plan check return values, state changes, emitted events with their arguments, balances, and reverts with their reason or custom error.
- [ ] AC3: Gas or compute used per transaction is recorded; a plan can set a ceiling that fails the step when exceeded.
- [ ] AC4: A transaction that is not included or not final within the plan's timeout fails the step or makes the case BLOCKED with the reason; never PASSED.

### REQ-CHAIN-05 · Blockchain evidence

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-CHAIN-04, REQ-EVD-01, INV-7

**Acceptance criteria**

- [ ] AC1: Every transaction of a case is evidence: chain id, block, hash, sender and receiver aliases, decoded call, receipt, decoded events, gas and status, and the relevant state before and after.
- [ ] AC2: On test networks the report links each transaction to a block explorer; on local networks it includes the trace when the node offers one.
- [ ] AC3: Evidence files are in the manifest with their SHA-256; addresses of test accounts are shown with their alias.

### REQ-CHAIN-06 · dApp front-ends with wallets as plugins

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-CHAIN-01, REQ-CHAIN-03, REQ-EXEC-05, REQ-GEN-11

**Acceptance criteria**

- [ ] AC1: Browser wallets run as plugins driven by the framework in web cases: MetaMask, Rabby, Coinbase Wallet, Phantom, Keplr and WalletConnect (with a test wallet on the other side), loaded at pinned versions.
- [ ] AC2: Connecting, switching networks and accounts, approving and rejecting signature and transaction requests are plan steps; the request the wallet shows is evidence and checked against the plan (method, amount, recipient, contract).
- [ ] AC3: The wallet is set up by code from the secret provider for each run (test seed or key, networks from the allowlist), never by an agent.
- [ ] AC4: Mobile dApps with mobile wallets follow REQ-EXEC-06 once mobile wallet drivers exist; until then such cases are BLOCKED with the reason.

### REQ-CHAIN-07 · Wallets as the application under test

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-CHAIN-06, REQ-EXEC-05, REQ-EXEC-06, INV-8

**Acceptance criteria**

- [ ] AC1: A wallet (browser extension, mobile or desktop app) can be the application under test: onboarding, seed import and backup with test seeds, account and network management, sending, receiving and signing.
- [ ] AC2: What the wallet signs is checked by code: the signed transaction or message is decoded and compared with what the wallet showed the user and with the plan; any difference fails the step.
- [ ] AC3: Seed phrases and keys typed or shown during a case are masked in screenshots, videos, DOM snapshots and logs.

### REQ-CHAIN-08 · Testing chains and nodes directly

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-CHAIN-01, REQ-CHAIN-02, REQ-PERF-01

**Acceptance criteria**

- [ ] AC1: Node and client changes can be tested against the chain's RPC specification (for example Ethereum JSON-RPC, Solana RPC): methods, parameters, errors and response schemas.
- [ ] AC2: A multi-node local devnet can be started to check block production, finality, reorg handling and the activation of protocol upgrades at a planned height.
- [ ] AC3: Throughput and latency of a node run through the performance requirements (REQ-PERF) with thresholds from the plan.

### REQ-CHAIN-09 · Security analysis and fuzzing as runners

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-CHAIN-04, REQ-EXEC-35, REQ-EXEC-57, INV-1

**Acceptance criteria**

- [ ] AC1: Static analysers and fuzzers run as additional runners: Slither, Aderyn and Mythril for Solidity; Foundry fuzz and invariant tests and Echidna; chain-specific tools for Solana and Move where they exist.
- [ ] AC2: The verdict comes from each tool's own output; severity thresholds and fuzz budgets come from the frozen plan.
- [ ] AC3: A finding links to the source lines and, for fuzzing, to the reproducing input, kept as evidence.

### REQ-CHAIN-10 · Off-chain parts: indexers, oracles and bridges

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-CHAIN-02, REQ-EXEC-46, REQ-ENV-05

**Acceptance criteria**

- [ ] AC1: Indexers (for example The Graph subgraphs) are checked against the chain: after a transaction, the indexed data matches the events within a timeout.
- [ ] AC2: Oracles and price feeds can be replaced by controlled stubs on local networks, with the values from the plan.
- [ ] AC3: Bridges and cross-chain messages can be tested between two local networks, waiting for finality on both sides.

### REQ-CHAIN-11 · Agents and keys

- Status: proposed
- Priority: must
- Stage: later
- Related: REQ-CHAIN-03, REQ-VER-03, INV-2, INV-8

**Acceptance criteria**

- [ ] AC1: No agent tool can sign, send a transaction or read a key; signing happens only in the trusted runner and the wallet driver, from approved plan steps.
- [ ] AC2: An adversarial test suite shows that an agent cannot reach a key, a seed or a signing function through tools, generated specs or wallet pages.
- [ ] AC3: Contract sources, transaction data and on-chain strings are untrusted data for the agents (prompt injection).

### REQ-CHAIN-12 · Analysis and plan before implementation

- Status: proposed
- Priority: must
- Stage: later
- Related: REQ-CHAIN-01, REQ-GEN-11

**Acceptance criteria**

- [ ] AC1: An ADR chooses the first chain families, wallets and tools from user demand, with the interface of REQ-CHAIN-01 and the plugin packaging.
- [ ] AC2: A demo dApp (contract, front-end, wallet) with seeded bugs, like the demo shop, proves detection before the area is called supported.
- [ ] AC3: The roadmap gets stages for this area once the ADR is accepted.
