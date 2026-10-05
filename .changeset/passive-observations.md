---
"@qajitsu/core": minor
"@qajitsu/report": minor
"@qajitsu/adapter-runner-web": minor
"@qajitsu/cli": minor
---

Passive observations (REQ-EVD-07): web runs record browser console errors, 4xx/5xx responses and axe-core WCAG A/AA
violations of every visited page in `observations.json`; with OpenAPI contract mismatches they are listed in their
own section of `report.html` and the Jira comment and never change a status or a count. Configure under
`observations:` (switch checks off, ignore entries). New dependency: `axe-core` (MPL-2.0).
