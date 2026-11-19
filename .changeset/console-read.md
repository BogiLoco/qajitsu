---
"@qajitsu/cli": minor
---

`qj console` (REQ-WEB-01): the local web console over every registered project, its tickets and runs, with the
statuses each run computed, its matrix, plan versions, report and evidence, read from the files the CLI writes. It
listens on 127.0.0.1, signs in only the browser that opens the printed address, refuses other hosts, runs no script in
its pages and shows run files in a sandbox (ADR-0019). Read-only; plan review comes next.
