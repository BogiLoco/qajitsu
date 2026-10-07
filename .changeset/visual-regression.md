---
"@qajitsu/core": minor
"@qajitsu/steps": minor
"@qajitsu/verifier": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/adapter-runner-web": minor
"@qajitsu/agents": minor
"@qajitsu/cli": minor
---

Visual regression (REQ-EXEC-12): `expect.visual` compares a step's screenshot (masked regions) with the baseline in `.qa/baselines/` per browser, viewport and locale; above the threshold → FAILED with baseline, screenshot and diff; no baseline → NEEDS_REVIEW (`review` assertions never PASS) with the screenshot proposed; `qj baseline accept` (manifest-checked) is the only way baselines change. New dependencies in runner-web: pngjs 7 (MIT), pixelmatch 8 (ISC).
