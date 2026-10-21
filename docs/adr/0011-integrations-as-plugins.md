# 0011. Integrations as plugins, installed on demand

- Status: Proposed
- Date: 2026-10-21
- Related: REQ-GEN-11, REQ-GEN-12, REQ-GEN-02, REQ-GEN-06, REQ-NFR-05, INV-1, INV-8, INV-12, ADR-0002

## Context

Every integration lives in this repository as its own package under `packages/adapters/` (twenty today). The CLI
depends on all of them, so every installation carries every integration, including heavy native ones (LanceDB is
about 230 MB on macOS) that most projects never use. Tools outside Node.js (browsers, Android SDK, Appium) already
install on demand through `qj setup`; integrations do not. There is also no way to add an integration that does not
ship with QAJitsu, and no place for integrations that are sold rather than given away.

## Decision (proposed)

- **Core and plugins.** The core installation keeps the adapters of the basic flow (Jira, GitHub, GitLab, local
  repositories, API and web runners, secrets from the environment, local evidence). Every other adapter becomes a
  plugin package, still developed and released from this repository.
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
