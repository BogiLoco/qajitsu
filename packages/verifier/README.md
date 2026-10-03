# @qajitsu/verifier

The only place where a test status is decided (`computeStatus`) and where publishing is gated (`gate*`, `combineGates`). Fail-closed by design: ambiguous runner output never becomes PASSED.

Requirements: REQ-VER-01, REQ-VER-02, REQ-VER-07, REQ-PLAN-06, REQ-EXEC-08. Next: assertion-lock AST diff (REQ-EXEC-09), plan coverage (REQ-EXEC-03), manifest hash check (REQ-VER-05), secret scan gate (REQ-CFG-06). Coverage threshold 95% (trust core).
