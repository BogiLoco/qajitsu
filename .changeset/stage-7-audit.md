---
"@qajitsu/core": minor
"@qajitsu/cli": minor
"@qajitsu/agents": minor
"@qajitsu/models": minor
"@qajitsu/verifier": minor
"@qajitsu/guard": minor
"@qajitsu/report": minor
---

Stage 7: auditor, canary and model benchmark. An independent auditor agent (fresh context, by default a model other
than the author's) reviews every PASSED case against the approved plan, raw results, text evidence and screenshots;
its findings and the canary (one PASSED case re-run with an inverted expectation) can only move PASSED to
NEEDS_REVIEW (`verification` section, `checks/` records protected by the guard, notes in report.html). Every planned
expectation now needs its own `verify()`: specs that leave one out are blocked, results without it are never PASSED.
`qajitsu bench --model <ref> [--role]` runs `.qa/bench.yaml` end to end with `--build` and reports detection, false
FAILED, BLOCKED, plan acceptance, time, tokens and cost. `runStructuredAgent` accepts images; `ModelPorts` accepts a
run-level model override.
