---
"@qajitsu/core": minor
"@qajitsu/adapter-runner-web": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/toolchain": minor
"@qajitsu/cli": minor
---

Browser channels and versions (REQ-EXEC-66): `web.browser` and `web.matrix.browsers` accept `chrome`, `chrome-beta`,
`msedge` and `msedge-beta`; `qj setup` installs the ones the matrix names (not on Linux arm64) and `qj doctor` lists
them with the version the browser reports. Every web attempt records the exact browser and version
(`attempts[].browser`), and the matrix, report and ticket comment name them per combination. `safari` and versioned
entries such as `chrome@118` are accepted but run only on a device farm: without one their combinations are BLOCKED
with the reason, never replaced by another browser, and they cannot be the primary browser. The planner also gets
repair hints for a selector used as a `state` path and for a case without evidence.
