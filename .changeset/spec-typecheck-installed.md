---
"@qajitsu/verifier": patch
---

The type check of generated specs finds the `@qajitsu/steps` types in an installed QAJitsu (REQ-EXEC-03/AC1). The
verifier depends on `@qajitsu/steps` and resolves it, instead of assuming a sibling folder that a pnpm installation
does not have. Before this fix, every spec in such an installation was BLOCKED with "Cannot find module
'@qajitsu/steps'".
