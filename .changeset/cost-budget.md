---
"@qajitsu/core": minor
"@qajitsu/models": minor
"@qajitsu/agents": minor
"@qajitsu/report": minor
"@qajitsu/cli": minor
---

Ticket and month budgets (REQ-FLOW-06): `budget.ticket` and `budget.month` limit the cost, tokens and active minutes
of one version of a ticket's content and of the project per calendar month (`budget.time_zone`). Every model call and
every command's active time go to a spend ledger written by code, attributed to their case (the auditor's shared by
the cases it reviewed) or to the ticket. Budgets are checked before a new run, before and after every model call and
before each case; a stop makes model stages BLOCKED and unwritten cases NOT_RUN with the scope, spent amount, limit
and period, never changing a status, and the Jira comment gets a budget section. A local model costs nothing; a paid
model without a price is refused under a ticket or month cost limit. `qj budget` shows the spend against every limit
and the most expensive tickets and cases, `qj status` the tickets close to their budget, and a ledger that does not
match the run journals stops new runs until `qj budget --rebuild`.
