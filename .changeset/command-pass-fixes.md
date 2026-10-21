---
"@qajitsu/cli": patch
---

Fixes from the exploratory pass over every command (REQ-NFR-09): `qj export` says what its exit code means,
`qj regression` no longer estimates models it does not use, `qj init` names the right next step after choosing
models, `qj projects remove` lists an exported profile it deletes, and `qj knowledge search` and `qj note` take
unquoted words.
