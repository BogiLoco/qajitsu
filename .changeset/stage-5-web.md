---
"@qajitsu/core": minor
"@qajitsu/cli": minor
"@qajitsu/agents": minor
"@qajitsu/steps": minor
"@qajitsu/verifier": minor
"@qajitsu/report": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/adapter-runner-web": minor
"@qajitsu/adapter-publish-jira": minor
---

Stage 5: web and mixed tests. The trusted parent drives a Playwright browser for sandboxed specs (ADR-0004) with a
screenshot per step, full-page screenshot, DOM, video and trace on failure, HAR and console per case; `ui.*` in the
steps API and `elements`/`texts` expectations in plans; the healer limited to selectors and waits by an AST diff
(healed passes are NEEDS_REVIEW); parallel workers; `qajitsu logs`, a timeline and a transition graph in report.html;
`qajitsu evidence` opens the report, videos and traces; `qajitsu pull` downloads CI evidence from Jira; ffmpeg video
compression before upload. `CaseRuntime.endStep`, `verify` and `finish` are now async.
