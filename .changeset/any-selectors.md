---
"@qajitsu/steps": minor
"@qajitsu/adapter-runner-web": minor
"@qajitsu/adapter-runner-mobile": minor
"@qajitsu/verifier": minor
"@qajitsu/agents": patch
"@qajitsu/core": minor
"@qajitsu/cli": patch
---

Selectors for any web or mobile application (REQ-EXEC-21): `web.test_id_attribute` (e.g. `data-qa`) for `testid:`,
the element inventory and snapshots; new selector kinds `placeholder:`, `alt:`, `title:`, `id:` (web) and `id:`,
`xpath:` (native apps); on Android `testid:` also finds the resource id. The inventory finds Android `@+id`, SwiftUI
`.accessibilityIdentifier`, Flutter `Semantics(identifier:)`, `Key` and `ValueKey`. Static checks accept only the
kinds of the case's platform and flag `xpath:` for review. Prompts list selector kinds by stability and no longer use
demo-shop ids. A screen without any addressable element makes the case BLOCKED with that reason.
