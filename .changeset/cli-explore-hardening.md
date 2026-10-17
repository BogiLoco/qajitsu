---
"@qajitsu/cli": patch
"@qajitsu/core": patch
"@qajitsu/agents": patch
"@qajitsu/report": patch
---

Command-line exploratory sessions after the security and code review: Ctrl+C or SIGTERM stops the session and still
cleans up everything it started and removes the sandbox; the time box stops a running command and queued ones never
start; output of background commands is masked as a whole so a secret printed across two reads stays masked; the live
view keeps background lines whole, masks multi-line secrets line by line, and strips terminal escape sequences from
everything shown or recorded; more argument forms that name paths outside the sandbox are refused (`-o/x`, `--out:/x`,
`@/x`, `file:` URLs, links out of the sandbox); `.env*` and `.qa-runs` of a fixture are never copied or read; the proxy
drops hop-by-hop and `Proxy-Authorization` headers; `explore.cli.<tool>.allowlist` takes http(s) origins only; agent
text in `report.md` cannot form links or images. The explorer's checklist check accepts `qj doctor` in backticks or
quotes, ignores prose such as "qj prints help", and refuses items of `--check` swapped in the answer.
