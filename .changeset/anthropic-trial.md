---
"@qajitsu/agents": patch
"@qajitsu/verifier": patch
"@qajitsu/cli": patch
---

Found in the first run with a cloud model (Claude Haiku 4.5) on the demo shop:

- A planner that claims existing coverage when the run has no tests repository no longer loses the plan: each claim
  becomes an open question for the person reviewing (which test, which criteria, that no case was written), and the
  message for a wrong tests repository names the ones the run has. Claude cited the application's own tests three
  times and the plan failed.
- The estimate before a run counts only the cases chosen with `--cases`.
