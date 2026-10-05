# 0005. Core interfaces follow the seams the code really plugs in at

- Status: Accepted
- Date: 2026-10-05
- Related: REQ-GEN-02, INV-1, INV-11, INV-12; ADR-0002, ADR-0004

## Context

REQ-GEN-02 asks for adapter interfaces in `@qajitsu/core` with a shared contract test suite each. Five of the eight
interfaces (TicketSource, CodeHost, SecretProvider, EvidenceStore, Publisher) are implemented by adapters and
covered by contracts. Three were written before the code that would implement them and never matched it:

- `Runner.run(specFiles) → CaseRunResult[]` assumed a runner that executes whole spec files and reports results.
  ADR-0004 replaced that design: the trusted parent executes one attempt of one case at a time
  (`AttemptExecutor`), the runner loop (`runCases`) is shared, and web and mobile only add a browser or device
  factory to the same executor.
- `EnvProvider.start(request)` took one request type for very different providers; the CLI called
  `startBuildEnvironment` and `checkHealth` directly instead.
- `ModelProvider` described one provider's models, while every caller needs "the model of this role" across
  configured providers, which `@qajitsu/models` implements as a registry.

Interfaces nobody implements cannot have contract tests, and they mislead contributors writing a new adapter.

## Decision

The interfaces describe what the code plugs in at, and the CLI uses them:

- **Runner → `AttemptExecutor`**: `(request: AttemptRequest) => Promise<AttemptRecord>`, one attempt of one case.
  `AttemptRequest`, `AttemptRecord` and `EvidenceItem` move to `@qajitsu/core`; `@qajitsu/steps` and the runner
  packages re-export them. The sandbox executor (ADR-0004) is the production implementation; web and mobile pass
  their browser or device factory to it. `CaseAttempt` and `CaseRunResult` stay as the input of status computation.
- **`EnvProvider`**: `start(signal?) → EnvironmentHandle { baseUrl, health, deployedSha?, stubs, stop() }`. A
  provider is built with its own options by a factory (`createComposeEnvProvider`, `createRemoteEnvProvider`), so
  each takes exactly what it needs. A provider never turns an application that is not up into a healthy handle:
  remote reports `health.ok: false`, a build that does not start throws `BuildStartError` with its logs.
- **`ModelProvider`**: `resolve(reference)` and `forRole(role)` returning `{ id, model, profile }` with the model
  handle opaque in core (invariant 11). `ModelRegistry` in `@qajitsu/models` extends it with the AI SDK types.

Each interface has a contract suite in `tests/contract/` that every implementation runs.

## Consequences

- A new environment (Kubernetes, a script), runner variant (device farm) or model source plugs in at the same
  place the built-in ones do, and its contract suite says what it must guarantee.
- Status computation is unchanged: verdicts still come from `AttemptRecord`s produced by the trusted parent
  (ADR-0002, ADR-0004); no interface lets an adapter set a status.
- `Runner` disappears from `@qajitsu/core`; adapter metadata says `implements: "AttemptExecutor"`.
