---
"@qajitsu/report": minor
"@qajitsu/cli": minor
---

Regression runs of promoted packs (REQ-EXEC-17): `qj regression [--env] [--packs] [--from] [--ref] [--publish]` runs every pack `qj promote` put in the tests repository again as a run of its ticket, with the sandboxed runners and no agent or model (no authoring, healing, auditor or triage). Specs and expected values are checked against the pack's hashes; a mismatch makes the case BLOCKED. The suite report (`regression.md`, `report.html`, `junit.xml`) lists regressions. `qj promote` now records `cases_sha256` in `expectations.yaml`.
