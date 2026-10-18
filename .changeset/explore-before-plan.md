---
"@qajitsu/cli": minor
"@qajitsu/core": minor
"@qajitsu/agents": minor
"@qajitsu/verifier": minor
---

Exploration before planning (REQ-PLAN-11): `qj explore review` lets a person accept or reject what exploratory
sessions found (observations, findings, not-done checklist items), keep accepted ones in the knowledge base with
`--keep`, and `qj plan` offers the planner only the accepted items. Cases may cite them as `{kind: explore}`; code
refuses items not accepted, turns cases with no source for their expected result into open questions, and lists
accepted not-done items no case covers.
