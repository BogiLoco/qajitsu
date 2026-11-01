---
"@qajitsu/core": minor
"@qajitsu/steps": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/verifier": minor
"@qajitsu/agents": minor
"@qajitsu/cli": minor
---

Test data per case (REQ-EXEC-53): a plan case lists the records it needs in `test_data`. Before each attempt the
runner creates them through the application's API (`test_data.kinds.<kind>.create/remove` in the project config, as
an account alias) or the project's data hook, each marked `qj-<ticket>-<run>-<case>-a<attempt>`, gives them to the
spec as `data.get("<name>")` and removes them afterwards in reverse order (`qj run --keep` leaves them). Data that
cannot be created ends the attempt before any step (BLOCKED); what was created and removed is masked evidence
(`test-data.json`); a failed removal is a journal warning. `qj data clean [<TICKET>] [--run <id>] [--all]` removes
leftovers by marker through `test_data.cleanup` or the hook. The planner sees the project's kinds and code refuses
others; static checks require `data.get()` to name a record of the case. `--keep` now applies to every run.
