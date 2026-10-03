# 0002. Test status is computed by code from runner output, never by an agent

- Status: Accepted
- Date: 2026-10-03
- Related: REQ-VER-01, REQ-VER-02, REQ-VER-07, INV-1..INV-8; plan section 10

## Context

The main risk of an agentic QA tool is a fabricated or upgraded result: a test reported as passed that failed or never ran. Prompt instructions alone cannot prevent this.

## Decision

Agents plan and author tests; deterministic runners execute them and code computes the status. Agents have no tool that sets a status and cannot write to `results/`, `evidence/` or the approved plan. Expected values come from the frozen plan, the healer cannot change assertions (AST diff), the auditor can only downgrade, and publish gates validate completeness, hashes and secrets before anything leaves the machine.

## Alternatives considered

- **Agent executes tests through MCP and reports the outcome**: simplest, but the result is only as trustworthy as the model's narrative.
- **Agent executes, a second agent verifies**: two models can share the same failure mode; still no ground truth.

## Consequences

- Good: a FAILED result cannot become PASSED without a code change, and every protection is testable with adversarial tests.
- Bad: generated tests must follow the `@qajitsu/steps` contract, which constrains the author agent; weak assertions remain possible and are mitigated, not eliminated, by plan expectations, the auditor and the canary check.
