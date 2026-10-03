---
"@qajitsu/core": minor
"@qajitsu/cli": minor
"@qajitsu/agents": minor
"@qajitsu/steps": minor
"@qajitsu/verifier": minor
"@qajitsu/report": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/adapter-evidence-local": minor
"@qajitsu/adapter-env-remote": minor
---

Stage 3: `qajitsu run` executes the approved plan against a provided environment. Adds the steps runtime
(`step()`, `verify()`, `plan.expect()`, masked API evidence with cURL), the author agent with static checks
(lint, plan coverage, assertion lock, tsc), the sandboxed API runner on Playwright APIRequestContext with retries,
the local evidence store with a SHA-256 manifest, environment profiles with allowlist, production ban, health and
version checks and framework login of account aliases, status evaluation and publish gates in the verifier, and
CSV, XLSX and self-contained HTML reports with validated summaries.
