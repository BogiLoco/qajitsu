# ADR-0017: Ticket and month budgets read a spend ledger the run journals can rebuild

- Status: accepted
- Date: 2026-11-18
- Related: REQ-FLOW-06, REQ-LLM-09, REQ-LLM-11, REQ-NFR-11, REQ-WEB-11, INV-1, INV-2, INV-6

## Context

REQ-LLM-09 limits one run; its cost lives in `run.json`. REQ-FLOW-06 limits a ticket and a project over time, so it
needs the spend of many runs, also runs that are running at the same moment and runs that were cleaned away. The
owner decided that the ticket budget applies per version of the ticket's content, that runtime means active time,
that a local model is free and a paid model without a price is refused under a cost limit, and that the auditor's
cost is shared equally by the cases it reviewed. The later cost view (REQ-WEB-11) needs the same data per case,
ticket, model, role and stage.

Summing every run's journal before every model call would be correct but slow, and a journal is gone once its run
is cleaned, so a month total built only from journals would drop when someone runs `qj gc`.

## Decision

- **One ledger per project.** `<project runs>/budget/spend.jsonl`, one JSON line per model call (time, ticket, ticket
  version, run, stage, role, model, case ids, apportioned, input, cached and output tokens, cost or `null`) and one per
  command with the active time it added. It is written by code only, under a file lock, from the usage tracker that
  also writes the journal's `model.usage`; every call waits for its line before it returns, so a command that ends
  right after a call never loses it. The ledger lies outside every run workspace, where the guard denies agent writes.
- **Ticket version.** The SHA-256 of the ticket's normalised summary, description and acceptance criteria. Status,
  comments and labels are not part of it.
- **Active time.** A command adds the difference between its run's active time (`runTiming` of the journal) and what
  the ledger already holds for the run, in one locked step, so time is never counted twice and nothing has to be
  written into `run.json` after the run was sealed and certified.
- **Checks.** Before a new run (`qj fetch`: the month before the run exists, the ticket once its version is known),
  before every model call (the ledger is read only when a ticket or month limit exists), after every call, and before
  each case for active minutes. Parallel runs read the shared ledger, so a limit is overrun by at most the calls in
  flight.
- **The journals are the authority.** `qj budget --rebuild` regenerates the entries of every run whose journal is on
  disk and keeps the entries of the others, so cleaning runs never lowers a total. Before every command that spends
  under a ticket or month limit (`fetch`, `plan`, `approve`, `run`, `explore`) the ledger is compared per run with
  the journal: a fingerprint of every model call (month in `budget.time_zone`, stage, role, model, cases, tokens,
  cost), every entry of the run booked to the run's own ticket and version, and no more active time than the journal
  holds. Active time the ledger lacks (a command interrupted before it added its time, a removed line) is added from
  the journal. A ledger that does not parse or does not match refuses the command until it is rebuilt. Runs that
  are active are skipped, because their journal and ledger are written at the same moment. The journal's proofs are
  cached by the SHA-256 of the journal (`budget/journals.json`, written atomically; a broken cache is only slower).
- **Statuses stay with the runner (INV-1).** A stop turns into BLOCKED for a model stage and NOT_RUN for cases without
  a spec, with the reason; specs already written still run. The stop never sets or raises a status, and the comment's
  budget section and the move to `needs_review` come from the journal's `budget.exceeded` and the computed statuses.

## Consequences

- Projects that used QAJitsu before this change and then set a ticket or month limit must run `qj budget --rebuild`
  once: their earlier runs have journals but no ledger lines, and the comparison says so.
- The protection is against lost lines, partial writes, accidental deletion, agents (the ledger and the ticket
  snapshot are outside what the guard lets them write) and a ledger edited by hand. It is not against the project's
  own administrator: a person who can write the runs folder can also forge the journal cache or raise the limits in
  `qa.project.yaml`.
- "Active" is a live process id in the run's lock. A stale lock whose id was reused keeps a run out of the comparison
  until the process ends; a rebuild waits for it too.
- A run whose process died between a call and its ledger line shows as a mismatch; a rebuild fixes it from the
  journal.
- The ledger has the data REQ-WEB-11 needs; the console reads it instead of the journals.
