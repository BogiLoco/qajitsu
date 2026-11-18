# ADR-0018: A batched audit holds PASSED back until it is collected

- Status: accepted
- Date: 2026-11-18
- Related: REQ-VER-06, REQ-LLM-12, REQ-FLOW-06, REQ-VER-16, INV-1, INV-2, INV-5, INV-11

## Context

Provider batch APIs (Anthropic, OpenAI, Google) answer at half price within minutes and at most 24 hours. REQ-LLM-12/AC3
asks that work that is not time-critical can use them. The dependent steps of a run (analysis, plan, author, healer)
cannot wait hours for each answer. The audit can: it reviews finished results and every PASSED it questions only
goes to a person. It is also the most expensive call of many runs (a strong model with vision, every run).

An audit that has not answered yet has reviewed nothing. Showing its PASSED as PASSED would publish results the
project asked to have audited; showing them as anything else must not let the later answer look like an upgrade.

## Decision

- **The registry offers the batch, agents ask for it.** `ResolvedModel.batch` wraps AI SDK 7's experimental batch
  API for Anthropic, OpenAI and Google models, with the provider's price factor (0.5). Other packages never import a
  provider SDK (INV-11); a provider without a batch API has no `batch`, and the audit runs at once with a journal note.
- **Queued is a fourth audit record.** `checks/audit.json` becomes `{ status: "queued" }` with the batch reference, the
  reviewed PASSED case ids and the SHA-256 of the request, which is kept masked in `checks/audit-request.json`. Both
  are written by the orchestrator, hashed into `run.json`, and in `checks/`, which no agent can write.
- **Queued holds back.** While queued, `applyVerificationChecks` turns every PASSED into NEEDS_REVIEW ("audit
  pending") in both modes, and the `audit-collected` publish gate fails. Nothing is published as NEEDS_REVIEW because
  of a pending audit, and nothing is published as PASSED without its audit.
- **Collecting replaces the record, code recomputes.** `qj audit collect` (and `qj publish`, once) asks the batch. An
  answer is checked like an immediate audit's (one finding for each reviewed PASSED case, no other case, no
  duplicates) and written as `done`; a failed, expired or cancelled batch, or an invalid answer, is written as
  `failed`, and the configured mode decides. The statuses are then computed again from the runner's results and the
  new record. A PASSED that was held back becomes PASSED again because the code that held it back no longer has a
  reason to, not because an agent raised it: the auditor's findings still only downgrade (INV-5).
- **One attempt, no tools.** A batched call cannot run tools or be repaired in a second round; the prompt says so.
  Because nothing can repair it, an invalid answer (not a report, a finding missing, duplicated or for a case it did
  not review) fails as a required audit: a malformed answer must not cancel a weak finding it carried.
- **Bound to its run and results.** The answer must name the run (`"audit": "<run id>"`), so another run's batch is
  refused. The queued record keeps a digest of the run's results and evidence manifest; if they changed before the
  answer is collected (the cases ran again), the audit fails as required. A new audit stage replaces an earlier
  queued record instead of keeping it.
- **Collected once.** Collecting takes the run lock, and the call is recorded once per batch even when a collect
  stops before writing its record.
- **No certificate while queued.** A run whose audit is queued is not certified (REQ-VER-15); a certificate is
  reused only when every file it covers is unchanged, so the collected record and the re-rendered reports get a new
  one.
- **Recorded when collected.** The call's tokens and cost, at the batch price, go to the run's usage and the spend
  ledger (REQ-FLOW-06) when it is collected, shared equally by the reviewed cases; the budget is checked before it is
  sent. The stored request and the answer go into the transcript as one exchange (REQ-VER-16).
- **Changed inputs are refused.** A request or queued record that no longer matches its hash stops collecting
  (`AUDIT_REQUEST_CHANGED`) and fails closed: the cases stay NEEDS_REVIEW and nothing is published.

## Consequences

- A project that publishes right after a run should keep `auditor_delivery: now`; `batch` suits nightly and CI runs
  that a person reviews later.
- A run whose batch is never collected stays NEEDS_REVIEW; that is the safe direction.
- The batch API is experimental in AI SDK 7; its use is behind `ModelBatch`, so a change in the SDK touches
  `packages/models` only.
