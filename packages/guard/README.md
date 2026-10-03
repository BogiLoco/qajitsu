# @qajitsu/guard

Wraps every agent tool call in QAJitsu's own code: default-deny tool list per stage, write bans on `results/`, `evidence/`, the approved plan, the journal and `run.json`, workspace confinement, and a URL allowlist. Every decision is journaled to `journal/events.jsonl`.

Requirements: REQ-VER-03, REQ-VER-04, REQ-ENV-01. Invariants 2 and 10. Coverage threshold 95% (trust core).
