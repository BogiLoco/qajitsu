---
"@qajitsu/core": minor
"@qajitsu/agents": minor
"@qajitsu/verifier": minor
"@qajitsu/guard": minor
"@qajitsu/adapter-testcases": minor
"@qajitsu/cli": minor
---

Import existing manual test cases (REQ-CTX-08): `test_cases:` in the project configuration reads the cases linked to a ticket from Xray Cloud, Zephyr Scale, TestRail or a CSV/Excel file during `qj fetch` into `imported/cases.json`. The planner gets them as untrusted data and cites them as `{kind: imported, id}`, which code checks against the imported ids; a source that cannot be reached is reported and planning continues. The guard protects `imported/`. New package `@qajitsu/adapter-testcases`, `TestCaseSource` interface and `xlsxRows` in core.
