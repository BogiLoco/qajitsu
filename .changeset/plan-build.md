---
"@qajitsu/cli": minor
---

`qj plan --build` starts the environment from the run's worktree and the mobile devices only to record the pages and
the app's first screen for the planner, then stops them (REQ-EXEC-22/AC9), so plans of applications built per run
expect the texts the application really shows.
