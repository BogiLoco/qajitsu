# Architecture invariants (non-negotiable)

These rules protect the core promise of QAJitsu: a FAILED test stays FAILED and the agent cannot invent results.
A change that breaks one of them is wrong even if every test passes. If a task seems to require breaking one,
stop and ask; propose an ADR instead.

1. **Verdict comes from the runner.** A test status (PASSED, FAILED, FLAKY, BLOCKED, NOT_RUN, NEEDS_REVIEW) is computed by code from runner output. No agent tool, prompt or LLM response may set, upgrade or override a status.
2. **Agents never write results or evidence.** Only runners and `@qajitsu/steps` write to `results/` and `evidence/`. The guard denies agent writes there and to `plan.approved.yaml`.
3. **Approved plan is frozen.** `plan.approved.yaml` is hashed (SHA-256) at approval. Nothing executes that is not in the approved plan; a hash mismatch blocks the run.
4. **Expected values come from the plan.** Generated tests read expectations through `plan.expect(...)`. The healer may change selectors and waits only; the assertion-lock AST diff rejects any change to `verify()` calls.
5. **Auditor can only downgrade.** The auditor may move PASSED to NEEDS_REVIEW, never the other way.
6. **Numbers in reports are computed.** Counts and statuses in matrix, report and Jira comment come from structured results. LLM-written summary text is validated against them and rejected on mismatch.
7. **Every evidence file is in the manifest** with its SHA-256; reports reference evidence by hash.
8. **Secrets never leave the secret provider unmasked.** Not into LLM context, logs, evidence, fixtures or Jira. Test accounts are aliases (`user:standard`); login happens in framework helpers.
9. **The orchestrator is code, not an agent.** Stage transitions, retries, timeouts and checkpoints are deterministic.
10. **Production is unreachable by default.** Environment and URL allowlists apply to agents and runners alike.
11. **Provider-agnostic core.** No package outside `packages/models` imports a specific LLM provider SDK.
12. **Adapters behind interfaces.** Core never imports `packages/adapters/*` directly; it depends on the interfaces in `@qajitsu/core`.
