---
"@qajitsu/core": minor
"@qajitsu/steps": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/adapter-runner-web": minor
"@qajitsu/adapter-runner-mobile": minor
"@qajitsu/cli": minor
---

Failure screenshots mark the failing element (REQ-EVD-08): when a web or mobile step fails, a copy of its screenshot gets a numbered red box around each element whose assertion failed and each region that differs from the visual baseline (`<step>-annotated.png`, with `<step>-annotations.json` listing field, expected and actual value); a missing element is noted, and with a baseline the baseline copy is marked too. The original screenshot is unchanged and no status changes. `report.html`, `qj evidence --failed`, the ticket comment and `qj bug` show the annotated copy first. New `ScreenBox`/`ScreenMark` types, `regions` on image comparisons, optional `bounds` on UI drivers and `annotate` on the case runtime.
