---
"@qajitsu/cli": minor
"@qajitsu/agents": minor
"@qajitsu/verifier": minor
"@qajitsu/adapter-runner-web": minor
"@qajitsu/adapter-runner-mobile": minor
"@qajitsu/steps": minor
"@qajitsu/core": minor
---

Snapshot of the running application (REQ-EXEC-22). Drivers list the elements a page or screen shows
(`UiDriver.elements`, from Playwright's accessibility snapshot and test ids, or from the Appium page source). Before
writing specs, `qj run` records each web case's pages and the app's first screen and gives the author every element
with the selectors that find it; selectors found nowhere go back to the author once. A failed UI attempt keeps
`failure-elements.json` for the healer, which now heals mobile cases too. `qj plan --env/--snapshot` records the
environment's pages when the code is not available, and the plan check flags elements no recorded page shows.
