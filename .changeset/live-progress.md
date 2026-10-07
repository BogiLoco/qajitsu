---
"@qajitsu/core": minor
"@qajitsu/steps": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/guard": minor
"@qajitsu/cli": minor
---

Live progress of a run (REQ-OBS-09): `qj run` prints each case start with a counter, each step and each attempt outcome as plain lines; the runner journals `step.start` as steps begin. `qj watch <TICKET>` serves a page on 127.0.0.1 with the cases, the step running now, the latest screenshot (`<run>/live/`, not evidence) and preliminary outcomes, then the computed statuses; a run that stopped is shown as stopped. New optional `progress` on `AttemptRequest` (`AttemptProgress`) and `onScreenshot` on the case runtime; the guard protects `live/`.
