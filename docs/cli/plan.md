# `qajitsu plan` and `qajitsu approve`

Roadmap stage 2. Turn the fetched context of a run into an approved, frozen test plan.

```text
qajitsu plan <TICKET> [--run <id>] [--revise "<instruction>"]
qajitsu approve <TICKET> [--run <id>] [--version <n>] [--confirm-open-questions] [--person]
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

Numbers written as text are converted by code where the OpenAPI document leaves no doubt (REQ-PLAN-12): a field
documented as `number` or `integer` whose expectation is exactly a decimal number (`total: "1.01"`) becomes that number
(`1.01`) before the version is stored, and `qj plan` lists every conversion under "Numbers written as text, converted
by code" (also in `run.json`, `planConversions`). Other formats (`"1,01"`, `"$1.01"`, `"1.01 PLN"`), a fraction for an
integer, string fields and projects without OpenAPI stay as written and are flagged as before. The planner is not sent
back for what code converts itself.

Coverage is computed by code (REQ-PLAN-14). Every acceptance criterion of the ticket is covered by a case that cites
it (`{kind: ac}` or a quote of it), by an existing test that lists it in `covers`, or by an exclusion with a reason in
`out_of_scope` that starts with its id (`AC3: why`). Every endpoint the analysis found in the change is covered by a
case whose step calls it (`POST /orders/42/cancel` calls `POST /orders/{id}/cancel`) or by an exclusion
(`POST /orders: why`). `qj plan` lists the rest under "Not covered by any case"; approving them needs an explicit yes in
the review or `qj approve --confirm-uncovered`, recorded in `run.json` (`planCoverage`), and a model step of the
approval flow hands such a plan to a person.

Exploration items a person accepted with `qj explore review` are offered to the planner as untrusted data and cited as
`{kind: explore, session: S01, item: O1}`; code refuses items nobody accepted, turns a case with no other source for its
expected result into an open question, and lists accepted not-done items no case covers as open questions
(REQ-PLAN-11). `qj plan` prints what became of each accepted item.

Everything ticket, PR, code and knowledge text is wrapped as untrusted data in prompts (REQ-CTX-05/AC6).
Token usage and estimated cost are journaled per call (`model.usage`); `models.token_budget` stops the run (REQ-LLM-07).

## `approve`

Freezes a version without the interactive loop (CI). Sources are re-checked, then `plan/plan.approved.yaml` is
written with its SHA-256, approver and time in `run.json` (REQ-PLAN-06). A run's approved plan cannot change;
start a new run to plan again. Execution and publishing verify the hash and stop on a mismatch.

### Approval flow with model approvers (REQ-PLAN-10, ADR-0010)

By default a person approves, as above. A project can configure a flow of steps in `.qa/qa.project.yaml`:

```yaml
approval:
  flow: [model, person] # steps in order: person or model; default [person]
  model: local/qwen3:14b # the model approver: required for a model step, another model than the planner
  model_only: as-computed # a flow without a person: results stay as computed (or `review`: PASSED → NEEDS_REVIEW)
  jira: off # or `comment`: the plan and every decision are posted to the ticket
```

`qj approve` runs the steps one after another:

- **Code decides first.** A plan with expectations code flagged (REQ-PLAN-09) or with open questions is handed
  over to a person; the model is not asked.
- **A model step** gets the ticket context and the plan (as untrusted data) and answers `approve`, `revise` with
  reasons (the command stops with exit code `2` and prints the `qj plan --revise` to run) or `handover` (the next
  person step decides; without one the command stops with `2` and says how a person approves). Its answer is
  validated like any agent output.
- **A person step** approves as the current user (`--approver` in CI). `--person` lets a person decide at once in
  place of the model steps, e.g. after a handover.
- **Choose a strong approver.** A weak model lets weak plans through. In a trial, gemma4:e2b approved guessed totals
  that qwen3:14b had sent back for a revision; the run then ended FAILED on those values. Code still refuses plans it
  flagged, and wrong expectations make tests fail rather than pass, but a strong approver saves the run.
- The plan is frozen when every step approved the same version. A flow of model steps only (`flow: [model]`) is the
  project's decision to run without a person in the loop: the run can go on at once.

Every decision is a record: `run.json` (`approvals`) and the journal (`approval.step`) keep the kind, identity,
decision, reasons, time, the SHA-256 of the plan version decided on, and for a model the SHA-256 of its prompt and of
its answer. A plan approved by a model only is marked in the matrix, `report.html`, `junit.xml` and the Jira comment.
The `approval-intact` publish gate and `qj audit verify` check the records against the journal and the approved plan
file; a record changed afterwards fails both and every PASSED becomes NEEDS_REVIEW.

With `jira: comment` the plan is posted as one comment (updated for a new version) and each decision and the freeze
are comments of their own, with the hashes. A comment Jira refuses is a warning in the output and the journal; the
decision stands.

## `doctor --models`

Makes one small call per role's model: it must call a probe tool. Reports unreachable models and capabilities the
role needs but the model lacks (REQ-LLM-03). Declare capabilities of local models in
`models.providers.<alias>.models.<model>` after checking them with `ollama show`.

## Exit codes

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | Plan written, approved or quit without approval                         |
| 2    | `approve`: a model step asked for a revision, or a person must decide   |
| 2    | `plan`: token budget exceeded; the run is marked blocked                |
| 3    | Configuration error, invalid model output, ungrounded sources, no fetch |
