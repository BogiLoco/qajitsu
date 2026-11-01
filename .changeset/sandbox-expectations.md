---
"@qajitsu/adapter-runner-api": patch
---

The API runner's sandbox now gives the spec every planned expectation for `plan.expect(...)`: downloads, page state,
manifests, WebSockets, dialogs, messages and visual checks, not only status, fields, texts and elements. Before, a
spec reading one of those errored in a real `qj run` (the case ended BLOCKED, never PASSED); tests that replace the
executor did not show it. Found by the sandbox end-to-end tests of REQ-EXEC-45.
