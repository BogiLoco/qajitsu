---
"@qajitsu/agents": minor
"@qajitsu/cli": minor
---

Model inputs rebuilt from their snapshots (REQ-CTX-17/AC4): every model call keeps the texts of the fragments it
showed in the run, by hash (`context/fragments/<sha256>.txt`). `qj audit verify` rebuilds each call's input from its
`context.snapshot` (trimming applied again by code, rendered with the run's marker) and names every fragment that
changed or is missing; `qj reproduce` reports the same for the certified run before running it again. Runs from
before this change are skipped. `renderFragments` and `rebuildCall` are exported from `@qajitsu/agents`.
