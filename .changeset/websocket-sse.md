---
"@qajitsu/core": minor
"@qajitsu/steps": minor
"@qajitsu/verifier": minor
"@qajitsu/agents": minor
"@qajitsu/adapter-runner-api": minor
---

WebSocket and server-sent events in API steps (REQ-EXEC-47).

- **Plan:** a step expects `messages` by position (`"0.type": "price"`, `"count": 2`) within `stream.timeout_s`.
- **Specs:** `api.websocket(path)` with `send()`, and `api.events(path)`.
  `verify(step, "messages.<n>.<path>" | "messages.count", ...)` waits for the messages itself.
- **Trusted process:**
  - opens every stream with the account's headers, only to origins of the allowlist;
  - keeps every frame as masked evidence.
- **Outcomes:**
  - a message that does not come fails the step, with the close code and reason;
  - a stream that cannot be opened is BLOCKED.
- No new dependency: Node's built-in WebSocket client and fetch.
