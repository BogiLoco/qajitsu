---
"@qajitsu/core": minor
"@qajitsu/agents": minor
"@qajitsu/report": minor
"@qajitsu/cli": minor
---

`code: { access: full | metadata | none }` (REQ-CTX-10): a project can keep its code from QAJitsu. With `metadata`
only the PR/MR title, description and changed file names are kept; with `none` nothing is read from the code hosts.
Agents are told, `--build` says it needs the code, and the report header and `qj fetch` say what was shared.
