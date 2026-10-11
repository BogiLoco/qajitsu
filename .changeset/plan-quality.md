---
"@qajitsu/verifier": minor
"@qajitsu/agents": minor
"@qajitsu/cli": minor
"@qajitsu/core": patch
"@qajitsu/report": patch
---

Plans must be checkable: code flags placeholders instead of expected values, fields that are not in the OpenAPI
response (or have another type), steps with a description only and `testid:` selectors the code does not define;
the planner gets one automatic round to fix them, the review lists what remains and approving it needs a separate
confirmation (`qj approve --confirm-placeholders`), recorded in `run.json`. Planner and author get the element ids and
page paths found in the worktree. Fixes from the demo walkthrough: element expectations shown in the plan review, the
planner and author prompts describe web and mobile expectations and specs, `verify()` outside its step is rejected
statically, a reused plan brings its analysis, `qj watch` shows the run's statuses, screenshots go to vision models
as file parts.
