---
"@qajitsu/core": minor
"@qajitsu/steps": minor
"@qajitsu/adapter-runner-web": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/verifier": minor
"@qajitsu/report": minor
"@qajitsu/agents": patch
"@qajitsu/cli": patch
---

The recorded traffic is read by code (REQ-EVD-09/AC1+AC2): every request of the page is tied to its step; a failed or
blocked step lists the requests that went wrong (5xx, 4xx, timeouts, connection errors, allowlist refusals, CORS,
redirects to login) in `steps[].network`, `S1-network.json` and next to the failure in the report, and the failure
hints get it as structured data. Every attempt records the pages and endpoints it reached (`attempts[].requests`),
and the report lists which case reached which endpoint of the change. Web cases can check the page's WebSocket
messages (REQ-EXEC-47/AC3): `websocket.received.<n>` and `websocket.sent.<n>`, frames kept per step. Plan checks also
flag a dialog without an answer, invented manifest elements, and count a changed page as covered by a web case that
opens it. The demo shop gets a support chat over a WebSocket with BUG-17.
