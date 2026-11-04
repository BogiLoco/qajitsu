---
"@qajitsu/cli": patch
"@qajitsu/adapter-testcases": minor
---

Manual test cases from Xray, Zephyr Scale and TestRail are a plugin (REQ-GEN-11/AC1): `qj plugin add testcases`; `qj setup` installs it for a project with such `test_cases`. Cases from CSV and Excel files stay in the core. The adapter takes `@qajitsu/core` as a peer dependency and passes the new TestCaseSource contract, also as installed.
