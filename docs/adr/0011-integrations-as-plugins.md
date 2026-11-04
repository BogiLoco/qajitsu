# 0011. Integrations as plugins, installed on demand

- Status: Accepted
- Date: 2026-10-21, accepted 2026-11-01
- Related: REQ-GEN-11, REQ-GEN-12, REQ-GEN-14, REQ-GEN-02, REQ-GEN-06, REQ-NFR-05, INV-1, INV-8, INV-12, ADR-0002

## Context

Every integration lives in this repository as its own package under `packages/adapters/` (twenty-one in November 2026). The CLI
depends on all of them, so every installation carries every integration, including heavy native ones (LanceDB is
about 250 MB on macOS) that most projects never use. Tools outside Node.js (browsers, Android SDK, Appium) already
install on demand through `qj setup`; integrations do not. There is also no way to add an integration that does not
ship with QAJitsu, and no place for integrations that are sold rather than given away.

## Decision

- **Core and plugins.** The core installation keeps only what decides and records results (guard, verifier, status
  computation, masking, publish gates, the steps library) and what works without any external system: ticket files,
  local repositories, secrets from the environment, local evidence, the provided (remote) environment, the models
  layer and OpenTelemetry export. Everything else is a plugin package, still developed and released from this
  repository, Jira, GitHub, GitLab and the API and web runners included; `qj init` installs the ones a setup needs.
  The full list, the plugin types and the migration order are in the plugin inventory (`docs/architecture/plugins.md`,
  REQ-GEN-14).
- **Easy to extend.** A plugin implements the adapter interfaces of `@qajitsu/core` and declares its types in its
  manifest; adding one never needs a change to the core unless its interface has a gap, which gets its own ADR first.
- **One plugin per pull request.** Each move out of the core and each new plugin is its own pull request with its
  contract tests against the installed plugin.
- **Installed like tools.** Plugins install the way `qj setup` installs tools: the project configuration says which
  are needed, `qj doctor` names the missing ones, `qj setup` and `qj doctor --fix` install them into the QAJitsu home
  at versions pinned per release, checksum-verified, without install scripts, and into offline bundles.
- **Interfaces are the boundary.** A plugin implements the adapter interfaces of `@qajitsu/core` and nothing else. The
  guard, the verifier, status computation, masking and publish gates stay in the core and cannot be replaced.
- **Tiers.** Official open source, official commercial, partner and community plugins use the same mechanism. A
  commercial plugin checks a signed licence key offline; a missing licence stops only the commands that use it.
  The open-source core stays complete from ticket to published result.

## Consequences

- Smaller installations; heavy integrations only where used.
- Paid plugins become possible without closing the core: they are separate packages under their own licence. Adapters
  already released here under Apache-2.0 stay Apache-2.0.
- Every adapter needs contract tests that run against the plugin as installed, not only inside the monorepo.
- The CLI loads adapters dynamically; a missing plugin must fail with the install command, never with a module error.
