---
"@qajitsu/cli": patch
"@qajitsu/core": patch
"@qajitsu/verifier": minor
---

Found by exploratory testing of every qj command:

- `qj work`, `env`, `knowledge`, `audit`, `telemetry`, `ci` and `baseline` alone say which subcommands they have
  (they printed help and exited 3 without saying what was missing).
- `qj runs` shows one "Last stage" column, e.g. `fetch (completed)`, instead of "completed | fetch".
- A run without an approved plan says how to write and approve one.
- `RUN_ALREADY_EXECUTED` names how to start a new run: `qj fetch`, then `qj approve --reuse-from <run>`.
- The table `qj run` prints shows the hints for FAILED cases, as it does for BLOCKED ones.
- A plan whose api case calls an endpoint that answers 401 without login, and names no test account (`data.user`),
  is flagged before approval (REQ-PLAN-09/AC9): a local planner left the account out and every call failed with 401,
  looking like a product bug.
