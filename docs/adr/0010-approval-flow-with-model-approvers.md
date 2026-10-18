# 0010. Approval flow with model approvers, auditable and never in a model's favour

- Status: Accepted
- Date: 2026-10-18
- Related: REQ-PLAN-10, REQ-PLAN-07, REQ-PLAN-06, REQ-OBS-05, INV-1, INV-3, INV-4, INV-5, ADR-0002

## Context

The approved plan is where expected values come from (INV-4), and it is frozen by its SHA-256 at approval (INV-3).
Until now only a person could approve: REQ-PLAN-07/AC4 says new plans are never approved automatically. Teams that
want QA end to end without a person on every ticket asked for an approval flow where a step can be a model, for
example in Jira, as long as every decision can be audited.

A model approving a plan a model wrote can let a wrong expectation through, and then a test can pass because it
checks the wrong thing. The flow must not turn that risk into PASSED results nobody looked at.

## Decision

- **A flow of steps.** `approval.flow` in the project config lists the steps in order, each `person` or `model`. The
  default is `[person]`, exactly as before. A `model` step is used only when the project switches it on with
  `approval.model` (a model reference); no flag or prompt can switch it on.
- **A model approver is another model and only checks.** It must be a different model from the planner. It sees the
  ticket, the plan, its sources and what code found (plan flags, open questions) and answers approve, revise (with
  reasons) or hand over to a person; its answer is validated like any agent output. Code decides first: a plan with
  flagged expectations or open questions is never approved by a model; the step hands over to a person.
- **Every decision is a record.** Each step, person or model, is kept in `run.json` (`approvals`) and journaled in the
  hash chain: kind, identity (a person's name, or provider, model id and version), time, decision, the SHA-256 of the
  plan version decided on, and for a model the SHA-256 of its prompt and of its answer. The plan is frozen only when
  every step approved the same version.
- **The flow is the decision.** A project that configures a flow without a person step (`flow: [model]`) chose
  approval by a model; the run goes on at once and results are what code computed: PASSED stays PASSED. Matrix,
  report, junit and the Jira comment always say the plan was approved by a model only (which model, when, the
  hashes), so an audit sees there was no person in the loop. A project that wants to stay cautious sets
  `approval.model_only: review`: then PASSED results of such a plan become NEEDS_REVIEW (only downgrading, INV-5).
- **Jira.** With `approval.jira: comment`, the plan and each decision are posted to the ticket as comments with the
  plan's and the decision's hashes. A person still decides in the terminal or in CI (`/qa approve`); transitions are
  left for later.
- **Audit.** `qj audit verify` checks the approval records against the journal and the approved plan file; any
  mismatch fails the audit and the publish gates.

## Consequences

- REQ-PLAN-07/AC4 now reads: never approved automatically unless the project configures a model step in its approval
  flow.
- Model-only automation is possible end to end when the project configures it, and always visible; a reviewer sees
  which results rest on a plan no person approved, and a cautious project can keep them NEEDS_REVIEW.
- The model approver costs tokens on every approval; it is off by default.
