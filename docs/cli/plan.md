# `qajitsu plan` and `qajitsu approve`

Roadmap stage 2. Turn the fetched context of a run into an approved, frozen test plan.

```text
qajitsu plan <TICKET> [--run <id>] [--revise "<instruction>"]
qajitsu approve <TICKET> [--run <id>] [--version <n>] [--confirm-open-questions]
qajitsu doctor --models
```

## `plan`

1. Opens the latest run of the ticket (or `--run`); it must have been fetched.
2. **Analyst** (REQ-PLAN-01) reads the frozen ticket snapshot, diffs, PR/MR descriptions, review comments and
   `.qa/knowledge/*.md`, explores the worktrees with read-only, guarded tools and writes `analysis.json`.
3. **Planner** (REQ-PLAN-02) writes the plan; code validates the schema and checks every `source` against the
   ticket snapshot and the diff (REQ-PLAN-03). Invalid output goes back to the model with the errors, at most
   three attempts; then the stage fails and nothing is guessed (REQ-LLM-04).
4. The plan is stored as `plan/plan.vN.yaml` + `plan/plan.vN.md`.
5. In a terminal: `[a]ccept`, `[r]evise` (free text, creates the next version and shows `+ added`, `- removed`,
   `~ changed` cases), `[e]dit` (opens `$EDITOR`; the edit is schema- and source-checked before it becomes a version)
   or `[q]uit`. Accepting a plan with open questions needs an explicit `yes` (REQ-PLAN-05).

Everything ticket, PR, code and knowledge text is wrapped as untrusted data in prompts (REQ-CTX-05/AC6).
Token usage and estimated cost are journaled per call (`model.usage`); `models.token_budget` stops the run (REQ-LLM-07).

## `approve`

Freezes a version without the interactive loop (CI). Sources are re-checked, then `plan/plan.approved.yaml` is
written with its SHA-256, approver and time in `run.json` (REQ-PLAN-06). A run's approved plan cannot change;
start a new run to plan again. Execution and publishing verify the hash and stop on a mismatch.

## `doctor --models`

Makes one small call per role's model: it must call a probe tool. Reports unreachable models and capabilities the
role needs but the model lacks (REQ-LLM-03). Declare capabilities of local models in
`models.providers.<alias>.models.<model>` after checking them with `ollama show`.

## Exit codes

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | Plan written, approved or quit without approval                         |
| 2    | Token budget exceeded; the run is marked blocked                        |
| 3    | Configuration error, invalid model output, ungrounded sources, no fetch |
