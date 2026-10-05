---
"@qajitsu/core": minor
"@qajitsu/steps": patch
"@qajitsu/models": patch
"@qajitsu/adapter-runner-api": patch
"@qajitsu/adapter-env-remote": minor
"@qajitsu/adapter-env-compose": minor
---

Core interfaces follow the real seams (ADR-0005): `Runner` is replaced by `AttemptExecutor` with `AttemptRequest`,
`AttemptRecord` and `EvidenceItem` now in `@qajitsu/core`; `EnvProvider.start()` returns a handle with `baseUrl`,
`health`, `deployedSha`, `stubs` and `stop()`, implemented by `createRemoteEnvProvider` and
`createComposeEnvProvider`; `ModelProvider` is the registry shape (`resolve`, `forRole`) that `ModelRegistry`
extends. Every interface has a shared contract suite in `tests/contract/`.
