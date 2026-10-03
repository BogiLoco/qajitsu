# @qajitsu/cli

The `qajitsu` command (alias `qj`). Implemented: `--version`, `doctor`. Planned commands and their requirements are listed in `docs/requirements/generic.md` (REQ-GEN-05).

```bash
pnpm build
pnpm qajitsu doctor
```

Exit codes (REQ-CI-04): 0 all passed, 1 any failed, 2 blocked/flaky/not run/needs review, 3 framework or configuration error.
