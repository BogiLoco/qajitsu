---
"@qajitsu/cli": minor
"@qajitsu/verifier": minor
---

Plan review in `qj console` (REQ-WEB-07): two plan versions side by side with added, removed and changed cases, the
coverage matrix and the "changed but not tested" list, and approve, revise and edit buttons that run `qj approve`,
`qj plan --revise` and the plan edit with their rules, as the person who started the console. A change needs the
console's own origin and the session's form token. `coverageMatrix` in the verifier gives each criterion and endpoint
the cases that cover it; `checkPlanCoverage` is computed from it.
