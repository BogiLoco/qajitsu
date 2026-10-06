---
"@qajitsu/cli": minor
"@qajitsu/core": minor
---

`qj projects export <slug>` and `qj projects import <file>`: move a project to another machine with its `.qa/` files and knowledge sources (never secrets, the index or runs; exports with a secret value are refused). Credential masking now leaves references alone (`secret://`, `{{template}}`, `${VAR}`, `process.env.X`).
