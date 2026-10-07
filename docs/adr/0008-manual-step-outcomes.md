# 0008. Manual step outcomes come from a person, recorded by the trusted runtime

- Status: Accepted
- Date: 2026-10-07
- Related: REQ-EXEC-11, INV-1, INV-2, INV-8, ADR-0004

## Context

Some steps cannot be automated: an SMS or 2FA code, a physical device, a printout, a captcha. Invariant 1 says a
status is computed by code from runner output, and no agent may set one. A manual step has no runner output to
compute from: a person observes the outcome.

## Decision

- A plan step may be `manual: true` with instructions; its expectation is a description only. Only approved plan
  steps can be manual (plan schema, frozen by the approval hash).
- The spec marks the step with an empty `step()`. When the step ends, the **trusted runtime** (the parent process
  of ADR-0004, never the sandbox) asks a person through a `ManualPrompter` the orchestrator provides: in the terminal,
  or through `<run>/manual/<TC>.<S>.pending.json` answered with `qajitsu answer`.
- The answer becomes an assertion with `source: manual`, who and when, plus evidence (the record and an optional
  attachment) in the manifest with its SHA-256. Status computation treats it like any other assertion: failed →
  FAILED. No answer in time, no way to ask, or a skipped manual step → an error → BLOCKED. Never PASSED.
- No agent tool can answer: `manual/` is a protected path of the guard, and the prompter is not a tool.
- Cases with manual steps are not retried, healed or used as the canary, so nobody is asked twice.

## Consequences

- A status can depend on a person's statement. Reports name the person for every manual step (matrix, report,
  Jira comment), so a reader sees which results rest on a human observation.
- Notes are masked (registered secrets, credential shapes and 4–8 digit one-time codes).
- A run with manual steps needs someone present, in the terminal or in CI through `qajitsu answer`; the wait is
  bounded by `manual.timeout_s`.
