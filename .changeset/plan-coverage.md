---
"@qajitsu/verifier": minor
"@qajitsu/agents": minor
"@qajitsu/cli": minor
---

Coverage is computed by code (REQ-PLAN-14): every acceptance criterion and every changed endpoint needs a case, an
existing test or an exclusion with a reason; `qj plan` lists what is not covered, approving it needs
`--confirm-uncovered` (recorded), and a model approver hands such a plan to a person.
