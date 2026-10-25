---
"@qajitsu/cli": patch
"@qajitsu/agents": patch
"@qajitsu/verifier": patch
---

The planner's page snapshot also records the pages the code defines when no link reaches them (an offer page no menu
links to), so the plan sees their real texts; asset paths (`/sw.js`, `/manifest.webmanifest`) are no longer counted
as pages. A plan whose element key lacks its selector kind (`offer-status`) gets a repair hint naming
`testid:offer-status`.
