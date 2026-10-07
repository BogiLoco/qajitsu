---
"@qajitsu/core": minor
"@qajitsu/steps": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/verifier": minor
"@qajitsu/report": minor
"@qajitsu/agents": minor
"@qajitsu/guard": minor
"@qajitsu/cli": minor
---

Manual steps (REQ-EXEC-11, ADR-0008): plan steps can be `manual: true` with instructions; the run asks a tester in the terminal or waits for `qj answer` in CI; the answer is an assertion with `source: manual`, who and when, plus evidence; failed → FAILED, no answer → BLOCKED; reports name who performed each manual step; agents cannot answer (guard). `manual.timeout_s`.
