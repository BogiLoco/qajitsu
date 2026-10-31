---
"@qajitsu/verifier": patch
"@qajitsu/core": patch
"@qajitsu/cli": patch
---

Found by dogfooding test data with a local model (REQ-EXEC-53): a plan step that reads a record by an id the case
never creates (`GET /products/{id}` without `test_data` or an earlier POST) is flagged and goes back to the planner
once, then to the reviewer; a spec that does not read every record of its test data with `data.get()` goes back to
the author instead of testing a made-up id; and a record put under `data` is refused with a message that points to
`test_data`.
