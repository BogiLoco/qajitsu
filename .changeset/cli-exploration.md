---
"@qajitsu/cli": minor
"@qajitsu/core": minor
"@qajitsu/agents": minor
"@qajitsu/report": minor
---

Exploratory sessions of command-line tools (REQ-EXEC-24): `qj explore <ticket> --cli <tool>` lets the explorer use any
tool described in `explore.cli` (QAJitsu's own `qj` in the demo shop) in a throwaway sandbox with its own HOME, only
the configured variables, an allowlist proxy and argument arrays; every command's exit code, output and changed files
are recorded with SHA-256, leftover processes and containers are found and stopped, and `qj explore promote` writes a
regression test proposal for an observation.
