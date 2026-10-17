---
"@qajitsu/cli": patch
---

A command-line usage problem (missing argument, unknown option or command) exits 3 instead of 1, which pipelines read
as "a test FAILED"; `--help` and `--version` exit 0. Found by an exploratory session of `qj` with `qj explore --cli`.
