---
"@qajitsu/adapter-runner-api": patch
---

A WebSocket the server refuses (for example with HTTP 401) is reported at once as never opened on Node.js 22 too,
instead of waiting for the open timeout and reporting no answer.
